import { initCamera } from './camera.js';
import { initAI, setupMatch, decideAndMove, updateTeamCounts } from './ai.js';

const canvas = document.getElementById('threeCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f141b);

const simState = { active: false, paused: false, speedMul: 1.0 };

const { camera, controls } = initCamera(renderer, canvas, simState);

  // Luces
  scene.add(new THREE.AmbientLight(0x446688, 0.38));
  const dir = new THREE.DirectionalLight(0xffffff, 1.0); dir.position.set(20, 30, 12);
  dir.castShadow = true; dir.shadow.mapSize.set(4096, 4096); dir.shadow.camera.near = 0.5; dir.shadow.camera.far = 420; scene.add(dir);

  // ===== Terreno con montañas y planicies (FBM + ridged + domain warp) =====
  const ARENA_R = 36;
  const terrain = makeTerrain(260, 260, 240, 240);
  scene.add(terrain.mesh);
  export const heightAtWorld = (x, z) => terrain.heightAtWorld(x, z);
  export const slopeAt = (x, z) => terrain.slopeAt(x, z);

  // Anillo de referencia (límite jugable)
  {
    const ringGeo = new THREE.RingBufferGeometry(ARENA_R-0.6, ARENA_R, 160);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x4a9eff, transparent:true, opacity:.35, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI/2; ring.position.y = 0.03; scene.add(ring);
  }

  // === Ruido utilitario
  function Noise(seed=1337){
    let s = seed|0;
    function rnd(){ s = (s*1664525 + 1013904223) | 0; return (s>>>0)/4294967296; }
    const P = new Uint8Array(512);
    for (let i=0;i<256;i++) P[i]=i;
    for (let i=255;i>0;i--){ const j = (rnd()*256)|0; const t=P[i]; P[i]=P[j]; P[j]=t; }
    for (let i=0;i<256;i++) P[256+i]=P[i];
    function fade(t){ return t*t*t*(t*(t*6-15)+10); }
    function grad(h, x, y){
      switch(h & 3){
        case 0: return  x + y;
        case 1: return -x + y;
        case 2: return  x - y;
        case 3: return -x - y;
      }
    }
    this.perlin2 = function(x,y){
      const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
      const xf = x - Math.floor(x), yf = y - Math.floor(y);
      const u = fade(xf), v = fade(yf);
      const aa = P[P[X] + Y], ab = P[P[X] + Y + 1];
      const ba = P[P[X + 1] + Y], bb = P[P[X + 1] + Y + 1];
      const x1 = (1-u)*grad(aa, xf,   yf) + u*grad(ba, xf-1, yf);
      const x2 = (1-u)*grad(ab, xf,   yf-1) + u*grad(bb, xf-1, yf-1);
      return (1-v)*x1 + v*x2;
    };
    this.fbm = function(nx, ny, oct=5, lac=2.0, gain=0.5){
      let amp=1, freq=1, sum=0, norm=0;
      for (let i=0;i<oct;i++){
        sum += amp * this.perlin2(nx*freq, ny*freq);
        norm += amp; amp*=gain; freq*=lac;
      }
      return sum/norm;
    };
    this.ridged = function(nx, ny, oct=4, lac=2.0, gain=0.5){
      let amp=1, freq=1, sum=0, norm=0;
      for (let i=0;i<oct;i++){
        const n = this.perlin2(nx*freq, ny*freq);
        sum += amp * (1 - Math.abs(n));
        norm += amp; amp*=gain; freq*=lac;
      }
      return sum/norm;
    };
    this.domainWarp = function(x,y, amt=0.25){
      const qx = this.fbm(x+5.2, y+1.3, 3, 2.0, 0.5);
      const qy = this.fbm(x-2.8, y-3.1, 3, 2.0, 0.5);
      return [x + amt*qx, y + amt*qy];
    };
  }

  function makeTerrain(width, depth, segX, segZ){
    const noise = new Noise(20250809);
    const geo = new THREE.PlaneBufferGeometry(width, depth, segX, segZ);
    geo.rotateX(-Math.PI/2);
    const pos = geo.attributes.position;
    const colors = new Float32Array((segX+1)*(segZ+1)*3);
    const colorAttr = new THREE.BufferAttribute(colors, 3);
    geo.setAttribute('color', colorAttr);

    const roughSlider = document.getElementById('rough');
    const mtnSlider = document.getElementById('mtn');
    let roughness = parseFloat(roughSlider.value || 1.8);
    let mountaininess = parseFloat(mtnSlider.value || 0.55);

    function heightAtXZ(x, z){
      const nx = (x/width + 0.5) * 2 - 1;
      const nz = (z/depth + 0.5) * 2 - 1;
      const [wx, wz] = noise.domainWarp(nx*0.9, nz*0.9, 0.35);
      const biome = noise.fbm(wx*0.6, wz*0.6, 3, 2.0, 0.5)*0.5 + 0.5;
      const mountainMask = Math.pow(THREE.MathUtils.clamp(biome, 0, 1), 1.2);
      const base = noise.fbm(nx*1.2, nz*1.2, 4, 2.1, 0.55) * 0.6;
      const ridge = noise.ridged(nx*1.4, nz*1.4, 5, 2.05, 0.47) * 2.3;
      const m = THREE.MathUtils.clamp(mountaininess, 0.2, 0.85);
      const h = THREE.MathUtils.lerp(base, ridge, mountainMask * m);
      const r = Math.sqrt(nx*nx + nz*nz);
      const rim = THREE.MathUtils.smoothstep(0.85, 1.05, r);
      const bowl = -rim * 1.2;
      return (h + bowl) * roughness;
    }
    function recolor(){
      roughness = parseFloat(roughSlider.value || 1.8);
      mountaininess = parseFloat(mtnSlider.value || 0.55);
      for (let i=0; i<pos.count; i++){
        const x = pos.getX(i), z = pos.getZ(i);
        const y = heightAtXZ(x, z);
        pos.setY(i, y);
        const cIdx = i*3;
        if (y < 0.2){ colors[cIdx+0]=0.10; colors[cIdx+1]=0.16; colors[cIdx+2]=0.20; }
        else if (y < 1.0){ colors[cIdx+0]=0.16; colors[cIdx+1]=0.24; colors[cIdx+2]=0.29; }
        else if (y < 2.3){ colors[cIdx+0]=0.22; colors[cIdx+1]=0.30; colors[cIdx+2]=0.34; }
        else { colors[cIdx+0]=0.30; colors[cIdx+1]=0.35; colors[cIdx+2]=0.38; }
      }
      pos.needsUpdate = true;
      colorAttr.needsUpdate = true;
      geo.computeVertexNormals();
    }
    recolor();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness:.12, roughness:.96 });
    const mesh = new THREE.Mesh(geo, mat); mesh.receiveShadow = true;

    function heightAtWorld(x,z){ return heightAtXZ(x, z); }
    function slopeAt(x,z){
      const e = 0.5;
      const h = heightAtXZ(x,z);
      const hx = heightAtXZ(x+e,z), hz = heightAtXZ(x,z+e);
      const dx = Math.abs(hx - h), dz = Math.abs(hz - h);
      return Math.sqrt(dx*dx + dz*dz);
    }
    roughSlider.addEventListener('input', () => {
      roughness = parseFloat(roughSlider.value || 1.8);
      document.getElementById('roughLbl').textContent = roughness.toFixed(1);
      recolor();
      respawnDecor();
    });
    mtnSlider.addEventListener('input', () => {
      mountaininess = parseFloat(mtnSlider.value || 0.55);
      document.getElementById('mtnLbl').textContent = mountaininess.toFixed(2);
      recolor();
      respawnDecor();
    });
    return { mesh, heightAtWorld, slopeAt };
  }

  // ===== Decorado y obstáculos: piedras + árboles =====
  let obstacles = []; // { mesh, pos:Vector3, rad:number }
  function makeTree(){
    const group = new THREE.Group();
    const trunk = new THREE.Mesh(
      new THREE.CylinderBufferGeometry(0.18, 0.26, 1.7, 8),
      new THREE.MeshStandardMaterial({ color: 0x7b4f2a, roughness:.95 })
    ); trunk.position.y = 0.85; trunk.castShadow = true; trunk.receiveShadow = true; group.add(trunk);
    const foliage = new THREE.Mesh(
      new THREE.ConeBufferGeometry(1.05, 2.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x2e5d3e, roughness:.9 })
    ); foliage.position.y = 2.25; foliage.castShadow = true; foliage.receiveShadow = true; group.add(foliage);
    return { group, radius: 0.95 };
  }
  function makeRock(){
    const mesh = new THREE.Mesh(
      new THREE.DodecahedronBufferGeometry(1.0, 1),
      new THREE.MeshStandardMaterial({ color: 0x6a737b, roughness:.95, metalness:.04 })
    );
    mesh.castShadow = true; mesh.receiveShadow = true;
    return { mesh, radius: 0.9 };
  }
  function segmentIntersectsSphere(p0, p1, c, r){
    const d = new THREE.Vector3().subVectors(p1, p0);
    const f = new THREE.Vector3().subVectors(p0, c);
    const t = THREE.MathUtils.clamp( -f.dot(d) / d.lengthSq(), 0, 1 );
    const proj = new THREE.Vector3().addVectors(p0, d.multiplyScalar(t));
    return proj.distanceTo(c) <= r;
  }
  function blockedLOS(aPos, bPos){
    for (let i=0;i<obstacles.length;i++){
      const o = obstacles[i];
      if (segmentIntersectsSphere(aPos, bPos, o.pos, o.rad*1.1)) return true;
    }
    return false;
  }

  function respawnDecor(){
    const rockCount = parseInt(document.getElementById('rocks').value||36);
    const treeCount = parseInt(document.getElementById('trees').value||48);
    const factor = parseFloat(document.getElementById('structRad').value||1.0);
    document.getElementById('rocksLbl').textContent = String(rockCount);
    document.getElementById('treesLbl').textContent = String(treeCount);
    document.getElementById('structRadLbl').textContent = factor.toFixed(2) + "×";

    obstacles.forEach(o => scene.remove(o.mesh || o.group));
    obstacles = [];

    const maxR = ARENA_R * factor;

    // Piedras
    for (let i=0;i<rockCount;i++){
      const r = makeRock(); const mesh = r.mesh;
      for (let tries=0; tries<60; tries++){
        const ang = Math.random()*Math.PI*2;
        const rad = 3 + Math.random()*(maxR-1.8);
        const x = Math.sin(ang)*rad;
        const z = Math.cos(ang)*rad;
        const y = terrain.heightAtWorld(x,z);
        if (Math.hypot(x,z) < maxR && terrain.slopeAt(x,z) < 1.25){
          const s = 0.6 + Math.random()*1.6; mesh.scale.setScalar(s);
          mesh.position.set(x, y, z); mesh.rotation.y = Math.random()*Math.PI*2;
          scene.add(mesh);
          obstacles.push({ mesh, pos: new THREE.Vector3(x,y,z), rad: 0.7*s });
          break;
        }
      }
    }
    // Árboles
    for (let i=0;i<treeCount;i++){
      const t = makeTree(); const g = t.group;
      for (let tries=0; tries<60; tries++){
        const ang = Math.random()*Math.PI*2;
        const rad = 4 + Math.random()*(maxR-2.2);
        const x = Math.sin(ang)*rad;
        const z = Math.cos(ang)*rad;
        const y = terrain.heightAtWorld(x,z);
        const slope = terrain.slopeAt(x,z);
        if (Math.hypot(x,z) < maxR && slope < 0.85 && y > 0.05){
          const s = 0.8 + Math.random()*0.8; g.scale.set(s,s,s);
          g.position.set(x, y, z); g.rotation.y = Math.random()*Math.PI*2;
          scene.add(g);
          obstacles.push({ mesh: g, pos: new THREE.Vector3(x,y,z), rad: t.radius*s });
          break;
        }
      }
    }
  }
  respawnDecor();
  document.getElementById('rocks').addEventListener('input', respawnDecor);
  document.getElementById('trees').addEventListener('input', respawnDecor);
  document.getElementById('structRad').addEventListener('input', respawnDecor);

  // ========= Utilidades comunes =========
  const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
  function clamp(x,a,b){ return Math.min(b, Math.max(a, x)); }
  function randChoice(arr){ return arr[(Math.random()*arr.length)|0]; }
  function lookAt2D(obj, dirVec){
    const yaw = Math.atan2(dirVec.x, dirVec.z);
    obj.rotation.y = THREE.MathUtils.lerp(obj.rotation.y, yaw, 0.22);
  }
  function ground(u){ u.position.y = terrain.heightAtWorld(u.position.x, u.position.z); }
  function avoidObstacles(pos){
    tmpV.set(0,0,0);
    for (let i=0;i<obstacles.length;i++){
      const o = obstacles[i];
      const dXZ = new THREE.Vector3(pos.x - o.pos.x, 0, pos.z - o.pos.z);
      const d = dXZ.length();
      const R = o.rad + 1.0;
      if (d < R && d > 0.0001){ tmpV.add(dXZ.normalize().multiplyScalar((R - d) * 0.95)); }
    }
    return tmpV.clone();
  }
  function crowdRepel(u, dt){
    const allies = alliesOf(u);
    tmpV.set(0,0,0);
    for (let i=0;i<allies.length;i++){
      const a = allies[i]; if (a===u || !a.userData.alive) continue;
      const d = u.position.distanceTo(a.position);
      if (d < 1.05 && d > 0.0001){ tmpV.add(u.position.clone().sub(a.position).setLength((1.05-d)*0.9)); }
    }
    u.position.addScaledVector(tmpV, dt);
  }

  // ====== Edición de spawn ======
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const spawnEdit = { active:false, teamIdx:-1, marker:null, dragging:false };

  function showSpawnMarker(){
    if (spawnEdit.teamIdx < 0 || spawnEdit.teamIdx >= teams.length) return;
    const team = teams[spawnEdit.teamIdx];
    if (!spawnEdit.marker){
      const geo = new THREE.SphereBufferGeometry(0.6, 16, 16);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
      spawnEdit.marker = new THREE.Mesh(geo, mat);
      scene.add(spawnEdit.marker);
    }
    const { x, z } = team.spawn;
    spawnEdit.marker.position.set(x, terrain.heightAtWorld(x, z) + 0.6, z);
    spawnEdit.marker.visible = true;
  }
  function hideSpawnMarker(){ if (spawnEdit.marker) spawnEdit.marker.visible = false; }
  function enterSpawnEdit(idx){ spawnEdit.active = true; spawnEdit.teamIdx = idx; showSpawnMarker(); }
  function exitSpawnEdit(){ spawnEdit.active = false; spawnEdit.teamIdx = -1; hideSpawnMarker(); }
  function updateSpawnFromEvent(e){
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hit = raycaster.intersectObject(terrain.mesh)[0];
    if (hit){
      const { x, z } = hit.point;
      const team = teams[spawnEdit.teamIdx];
      team.spawn.set(x, 0, z);
      if (!simState.active) repositionTeam(team);
      showSpawnMarker();
    }
  }
  function refreshSpawnMarker(){
    if (spawnEdit.active){
      if (spawnEdit.teamIdx >= teams.length) exitSpawnEdit();
      else showSpawnMarker();
    } else {
      hideSpawnMarker();
    }
  }

  // ======= UI =======
  const ui = {
    root: document.getElementById('ui'),
    toggle: document.getElementById('toggleUi'),
    status: document.getElementById('statusTxt'),
    start:  document.getElementById('startBtn'),
    pause:  document.getElementById('pauseBtn'),
    reset:  document.getElementById('resetBtn'),
    satellite:  document.getElementById('satelliteCam'),
    showTrails: document.getElementById('showTrails'),
    log:    document.getElementById('log'),
    speed: document.getElementById('speed'),
    speedLbl: document.getElementById('speedLbl'),
    composition: document.getElementById('composition'),
    teamSize: document.getElementById('teamSize'),
    teamSizeLbl: document.getElementById('teamSizeLbl'),
    teamsCount: document.getElementById('teamsCount'),
    teamsLbl: document.getElementById('teamsLbl'),
    teamsPanel: document.getElementById('teamsPanel'),
    rough: document.getElementById('rough'),
    mtn: document.getElementById('mtn'),
  };
  function collapseUI(){
    ui.root.classList.add('ui-collapsed');
    ui.toggle.style.display = 'block';
  }
  function expandUI(){
    ui.root.classList.remove('ui-collapsed');
    ui.toggle.style.display = 'none';
  }
  ui.toggle.addEventListener('click', expandUI);
  ui.speed.addEventListener('input', () => { simState.speedMul = parseFloat(ui.speed.value); ui.speedLbl.textContent = simState.speedMul.toFixed(2) + "x"; });
  ui.satellite.addEventListener('change', () => { controls.satellite = ui.satellite.checked; });
  controls.satellite = ui.satellite.checked;
  ui.teamsCount.addEventListener('input', ()=>{ ui.teamsLbl.textContent = ui.teamsCount.value; setupMatch(); });
  ui.teamSize.addEventListener('input', () => {
    const v = parseInt(ui.teamSize.value || 8);
    ui.teamSizeLbl.textContent = v;
    ui.teamsPanel.querySelectorAll('input.team-size').forEach(inp => { inp.value = v; });
    setupMatch();
  });
  ui.composition.addEventListener('change', () => {
    const val = ui.composition.value;
    ui.teamsPanel.querySelectorAll('select.team-comp').forEach(sel => { sel.value = val; });
    setupMatch();
  });

  const handleTeamFieldChange = (e) => {
    if (e.target.matches('.team-size, .team-comp')) {
      setupMatch();
    }
  };
  ui.teamsPanel.addEventListener('input', handleTeamFieldChange);
  ui.teamsPanel.addEventListener('change', handleTeamFieldChange);

  ui.teamsPanel.addEventListener('click', (e) => {
    const row = e.target.closest('.teamRow');
    if (!row) return;
    if (e.target.matches('input, select')) return;
    const idx = Array.from(ui.teamsPanel.children).indexOf(row);
    if (spawnEdit.active && spawnEdit.teamIdx === idx) exitSpawnEdit();
    else enterSpawnEdit(idx);
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (!spawnEdit.active) return;
    e.preventDefault(); e.stopPropagation();
    spawnEdit.dragging = true; updateSpawnFromEvent(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!spawnEdit.active || !spawnEdit.dragging) return;
    e.preventDefault(); e.stopPropagation();
    updateSpawnFromEvent(e);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!spawnEdit.active) return;
    e.stopPropagation();
    spawnEdit.dragging = false;
  });

  function log(text){ const d = new Date().toLocaleTimeString(); ui.log.insertAdjacentHTML('beforeend', `<div>[${d}] ${text}</div>`); ui.log.scrollTop = ui.log.scrollHeight; }

  ui.start.addEventListener('click', () => {
    if (simState.active) return;
    simState.active = true; simState.paused = false;
    allUnits.forEach(u => { u.userData.attackT = 0; u.userData.healT = 0; u.userData.isAttacking = false; u.userData.state=""; u.userData.stateT=0; });
    ui.start.disabled = true; ui.pause.disabled = false;
    ui.status.textContent = "¡Batalla en curso!"; log("¡La batalla ha comenzado!");
    collapseUI();
  });
  ui.pause.addEventListener('click', () => { if (!simState.active) return; simState.paused = !simState.paused; ui.pause.textContent = simState.paused ? "Reanudar" : "Pausar"; ui.status.textContent = simState.paused ? "Batalla pausada" : "¡Batalla en curso!"; });
  ui.reset.addEventListener('click', setupMatch);

  // ======= Salud y efectos =======
  function makeHealthBar(){
    const group = new THREE.Group();
    const bgGeo = new THREE.PlaneBufferGeometry(1.4, .14);
    const bgMat = new THREE.MeshBasicMaterial({ color: 0x6b1f1f, transparent:true, opacity:.65 });
    const bg = new THREE.Mesh(bgGeo, bgMat); group.add(bg);
    const fgGeo = new THREE.PlaneBufferGeometry(1.36, .10);
    const fgMat = new THREE.MeshBasicMaterial({ color: 0x55ff88 });
    const fg = new THREE.Mesh(fgGeo, fgMat); fg.position.z = 0.001; group.add(fg);
    group.userData.fg = fg; group.position.y = 2.35; return group;
  }
  const floatingTexts = [];
  function spawnText(worldPos, text, color = "#ffe36b"){
    const size = 128, cvs = document.createElement('canvas'); cvs.width = cvs.height = size;
    const ctx = cvs.getContext('2d'); ctx.font = "700 64px system-ui, Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = "black"; ctx.shadowBlur = 8; ctx.fillStyle = color; ctx.fillText(text, size/2, size/2);
    const tex = new THREE.CanvasTexture(cvs); tex.minFilter = THREE.LinearFilter;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent:true }));
    spr.scale.set(0.9, 0.9, 1); spr.position.copy(worldPos); spr.position.y += 2.6; scene.add(spr);
    floatingTexts.push({ spr, life: 0.0, max: 0.7 });
  }
  function updateFloatingTexts(dt){
    for (let i=floatingTexts.length-1; i>=0; --i){
      const ft = floatingTexts[i]; ft.life += dt; ft.spr.position.y += dt * 0.9;
      const a = 1.0 - (ft.life / ft.max); ft.spr.material.opacity = Math.max(0, a);
      if (ft.life >= ft.max){ scene.remove(ft.spr); ft.spr.material.map.dispose(); ft.spr.material.dispose(); floatingTexts.splice(i,1); }
    }
  }
  function hitSparks(pos, color = 0xffee88){
    const group = new THREE.Group();
    for (let i=0;i<16;i++){
      const g = new THREE.SphereBufferGeometry(0.05, 8, 8);
      const m = new THREE.MeshBasicMaterial({ color, transparent:true, opacity:.9 });
      const s = new THREE.Mesh(g, m);
      s.position.copy(pos);
      s.position.x += (Math.random()-.5)*0.4; s.position.y += (Math.random()-.5)*0.4 + 1.0; s.position.z += (Math.random()-.5)*0.4;
      group.add(s);
    }
    scene.add(group); setTimeout(()=> scene.remove(group), 320);
  }
  let shake = { t:0, power:0 }; const clock = new THREE.Clock();
  function triggerShake(power=0.25, time=0.12){ shake.t = time; shake.power = power; }
  function applyShake(){
    if (shake.t > 0){
      shake.t -= clock.getDelta(); const p = shake.power * (shake.t>0 ? (shake.t) : 0);
      camera.position.x += (Math.random()-.5) * p; camera.position.y += (Math.random()-.5) * p * .6; camera.position.z += (Math.random()-.5) * p;
    }
  }

  // ======= Unidades (modelos por clase) =======
  const BASE_SPEEDS = { guerrero:2.2, tanque:1.75, picaro:3.05, arquero:2.35, mago:2.1 };
  const NONHEALER_AVG_SPEED = (BASE_SPEEDS.guerrero + BASE_SPEEDS.tanque + BASE_SPEEDS.picaro + BASE_SPEEDS.arquero + BASE_SPEEDS.mago) / 5.0;

  function attachShield(leftPivot, size=0.7, color=0x9aa6b2){
    const shield = new THREE.Mesh(
      new THREE.CylinderBufferGeometry(size*0.6, size*0.6, size*1.2, 18),
      new THREE.MeshStandardMaterial({ color, metalness:.25, roughness:.5 })
    );
    shield.rotation.z = Math.PI/2;
    shield.position.set(0, -0.5, 0.18);
    shield.castShadow = true;
    leftPivot.add(shield);
    return shield;
  }
  function attachHelmet(root, color=0x888888){
    const helm = new THREE.Mesh(
      new THREE.SphereBufferGeometry(0.28, 16, 16, 0, Math.PI*2, 0, Math.PI/2),
      new THREE.MeshStandardMaterial({ color, metalness:.3, roughness:.4 })
    );
    helm.position.y = 1.52; helm.castShadow = true; root.add(helm); return helm;
  }
  function attachCloak(root, color=0x334466){
    const geo = new THREE.PlaneBufferGeometry(1.4, 2.0, 1, 2);
    const mat = new THREE.MeshStandardMaterial({ color, roughness:.95, metalness:.05, side: THREE.DoubleSide });
    const cloak = new THREE.Mesh(geo, mat); cloak.position.set(0, 1.3, -0.35); cloak.rotation.x = -0.2; cloak.castShadow = true; root.add(cloak); return cloak;
  }
  function attachQuiver(root){
    const tube = new THREE.Mesh(new THREE.CylinderBufferGeometry(0.12,0.12,0.8,10), new THREE.MeshStandardMaterial({ color:0x3b2c1a, roughness:.9 }));
    tube.position.set(-0.35, 1.1, -0.3); tube.rotation.z = 0.3; root.add(tube);
    const arrows = new THREE.Mesh(new THREE.CylinderBufferGeometry(0.02,0.02,0.6,6), new THREE.MeshStandardMaterial({ color:0xdddddd }));
    arrows.position.set(-0.35, 1.4, -0.3); root.add(arrows);
  }
  function attachOrb(pivot, color=0x88ffcc){
    const orb = new THREE.Mesh(new THREE.SphereBufferGeometry(0.14, 12, 12), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity:.35 }));
    orb.position.set(0, -0.3, 0.1);
    pivot.add(orb);
    return orb;
  }

  function equipWeapon(pivot, type){
    let mesh;
    if (type === "guerrero"){
      mesh = new THREE.Mesh(new THREE.BoxBufferGeometry(0.10, 1.6, 0.14), new THREE.MeshStandardMaterial({ color: 0xd7dee6, metalness:.6, roughness:.35 }));
      mesh.position.set(0, -1.25, 0);
    } else if (type === "tanque"){
      mesh = new THREE.Mesh(new THREE.CylinderBufferGeometry(0.18, 0.18, 1.5, 8), new THREE.MeshStandardMaterial({ color: 0x9aa6b2, metalness:.4, roughness:.5 }));
      mesh.position.set(0, -1.05, 0);
    } else if (type === "picaro"){
      mesh = new THREE.Mesh(new THREE.BoxBufferGeometry(0.07, 0.95, 0.07), new THREE.MeshStandardMaterial({ color: 0xe8e8e8, metalness:.5, roughness:.35 }));
      mesh.position.set(0, -0.9, 0);
      // segunda daga
      const off = mesh.clone(); off.position.x = -0.08; pivot.add(off);
    } else if (type === "arquero"){
      mesh = new THREE.Mesh(new THREE.TorusBufferGeometry(0.36, 0.02, 8, 16, Math.PI), new THREE.MeshStandardMaterial({ color: 0xdeb887, roughness:.8 }));
      mesh.rotation.z = Math.PI/2; mesh.position.set(0, -0.6, 0.15);
    } else if (type === "mago" || type === "sanador"){
      mesh = new THREE.Mesh(new THREE.CylinderBufferGeometry(0.05, 0.05, 1.7, 10), new THREE.MeshStandardMaterial({ color: (type==="sanador"?0x88ffcc:0xccccff), metalness:.1, roughness:.6 }));
      mesh.position.set(0, -1.05, 0);
      attachOrb(pivot, type==="sanador" ? 0x88ffcc : 0xccccff);
    }
    if (mesh){ mesh.castShadow = true; pivot.add(mesh); }
    return mesh;
  }

  function makeUnit(type, colorHex, teamRef){
    const root = new THREE.Group();
    // Silueta: ancho/alto varía por clase
    const scaleMap = { guerrero:1.0, tanque:1.15, picaro:0.9, arquero:0.95, mago:0.95, sanador:0.95 };
    const h = 1.2 * scaleMap[type];
    const body = new THREE.Mesh(new THREE.CylinderBufferGeometry(0.3*scaleMap[type], 0.42*scaleMap[type], h, 16), new THREE.MeshStandardMaterial({ color: colorHex, roughness:.7, metalness:.1 }));
    body.castShadow = true; body.position.y = h*0.5; root.add(body);
    const head = new THREE.Mesh(new THREE.SphereBufferGeometry(0.26*scaleMap[type], 16, 16), new THREE.MeshStandardMaterial({ color: 0xffdbac, roughness:.9 }));
    head.castShadow = true; head.position.y = h*0.5 + 0.92*scaleMap[type]; root.add(head);

    const legMat = new THREE.MeshStandardMaterial({ color: colorHex, roughness:.8 });
    const legGeo = new THREE.CylinderBufferGeometry(0.09*scaleMap[type], 0.12*scaleMap[type], 0.8*scaleMap[type], 12);
    const leftLeg = new THREE.Mesh(legGeo, legMat);  leftLeg.castShadow=true;  leftLeg.position.set(-0.16, h*0.5 - 0.4, 0); root.add(leftLeg);
    const rightLeg= new THREE.Mesh(legGeo, legMat);  rightLeg.castShadow=true; rightLeg.position.set( 0.16, h*0.5 - 0.4, 0); root.add(rightLeg);

    const armMat = new THREE.MeshStandardMaterial({ color: colorHex, roughness:.7 });
    const armGeo = new THREE.CylinderBufferGeometry(0.08*scaleMap[type], 0.1*scaleMap[type], 0.8*scaleMap[type], 12);
    const leftPivot = new THREE.Group();  leftPivot.position.set(-0.42, h*0.5 + 0.6, 0); root.add(leftPivot);
    const rightPivot= new THREE.Group(); rightPivot.position.set( 0.42, h*0.5 + 0.6, 0); root.add(rightPivot);
    const leftArm = new THREE.Mesh(armGeo, armMat);  leftArm.castShadow = true;  leftArm.position.y = -0.4; leftPivot.add(leftArm);
    const rightArm= new THREE.Mesh(armGeo, armMat); rightArm.castShadow = true; rightArm.position.y = -0.4; rightPivot.add(rightArm);

    // Accesorios por clase para diferencia visual
    if (type === "tanque"){ attachShield(leftPivot, 0.9, 0x9aa6b2); attachHelmet(root, 0x808a94); }
    if (type === "guerrero"){ attachShield(leftPivot, 0.6, 0x76838f); }
    if (type === "picaro"){ const hood = attachCloak(root, 0x222c36); hood.material.roughness = .98; }
    if (type === "arquero"){ attachQuiver(root); }
    if (type === "mago"){ attachCloak(root, 0x3a3f66); }
    if (type === "sanador"){ attachCloak(root, 0x2f5a4a); }

    const weapon = equipWeapon(rightPivot, type);
    const hp = makeHealthBar(); root.add(hp);
    const trailGeo = new THREE.PlaneBufferGeometry(0.14, 1.2);
    const trailMat = new THREE.MeshBasicMaterial({ color: 0xffffbb, transparent:true, opacity:0.0, side: THREE.DoubleSide });
    const trail = new THREE.Mesh(trailGeo, trailMat); trail.position.set(0.2, -0.9, 0); trail.rotation.x = Math.PI/2; rightPivot.add(trail);

    const statsMap = {
      guerrero: { hp:125, speed:BASE_SPEEDS.guerrero * 1.05,  dmg:[10,18], range:1.35, cd:0.75 },
      tanque:   { hp:200, speed:BASE_SPEEDS.tanque * 1.05,    dmg:[12,22], range:1.4,  cd:1.05, aoe:1.2 },
      picaro:   { hp:92,  speed:BASE_SPEEDS.picaro * 1.05,    dmg:[7,14],  range:1.25, cd:0.55, critBack:2.0, dodge:0.18 },
      arquero:  { hp:96,  speed:BASE_SPEEDS.arquero,   dmg:[8,15],  range:6.3,  cd:0.9,  projSpeed:11.0, keep:6.2, minKite:3.6 },
      mago:     { hp:86,  speed:BASE_SPEEDS.mago,      dmg:[14,24], range:7.1,  cd:1.4,  projSpeed:8.5, splash:1.3, keep:6.6, minKite:3.6 },
      sanador:  { hp:86,  speed:NONHEALER_AVG_SPEED*0.82, dmg:[0,0], range:1.2,  cd:1.0,  heal:[12,20], healRange:7.0, healCd:1.15, projSpeed:9.0, keep:7.2 }
    };
    const stats = statsMap[type];

    root.userData = {
      name: (type.charAt(0).toUpperCase()+type.slice(1)),
      type, teamRef, color: colorHex,
      speed: stats.speed, health: stats.hp, maxHealth: stats.hp,
      damageMin: stats.dmg ? stats.dmg[0]:0, damageMax: stats.dmg?stats.dmg[1]:0,
      attackRange: stats.range, attackCooldown: stats.cd,
      attackT: 0, healT: 0,
      isAttacking: false, attackAnim: 0, hitApplied: false,
      bobT: Math.random()*Math.PI*2, hpNode: hp, rightPivot, leftPivot, rightArm, leftArm, trail, weapon,
      aoe: stats.aoe || 0, critBack: stats.critBack || 1.0, dodge: stats.dodge || 0.0,
      projSpeed: stats.projSpeed || 0, keep: stats.keep || 0, minKite: stats.minKite || 0,
      // healer
      healMin: stats.heal?stats.heal[0]:0, healMax: stats.heal?stats.heal[1]:0, healRange: stats.healRange || 0, healCd: stats.healCd || 0,
      alive: true, target: null, retargetT: Math.random()*0.5,
      state: "", stateT: 0
    };
    root.castShadow = true;
    return root;
  }

  // Proyectiles
  const projectiles = [];
  function spawnProjectile(owner, target, kind){
    const obj = new THREE.Group(); let mesh;
    if (kind === "flecha"){
      mesh = new THREE.Mesh(new THREE.CylinderBufferGeometry(0.02, 0.02, 0.7, 6), new THREE.MeshBasicMaterial({ color: 0xffe0a8 }));
      const tip = new THREE.Mesh(new THREE.ConeBufferGeometry(0.05, 0.12, 6), new THREE.MeshBasicMaterial({ color: 0x888888 })); tip.position.y = 0.35; mesh.add(tip);
    } else if (kind === "bola"){
      mesh = new THREE.Mesh(new THREE.SphereBufferGeometry(0.16, 12, 12), new THREE.MeshBasicMaterial({ color: 0xff8855 }));
    } else if (kind === "cura"){
      mesh = new THREE.Mesh(new THREE.SphereBufferGeometry(0.18, 12, 12), new THREE.MeshBasicMaterial({ color: 0x88ffcc }));
    }
    obj.add(mesh);
    obj.position.copy(owner.position).add(new THREE.Vector3(0,1.2,0));
    scene.add(obj);
    projectiles.push({ obj, owner, target, kind, speed: owner.userData.projSpeed || 9.0, life: 2.8 });
  }
  function updateProjectiles(dt){
    for (let i=projectiles.length-1;i>=0;--i){
      const p = projectiles[i]; p.life -= dt;
      if (p.life <= 0 || !p.target || !p.target.userData.alive){ scene.remove(p.obj); projectiles.splice(i,1); continue; }
      tmpV.copy(p.target.position).add({x:0,y:1.2,z:0}).sub(p.obj.position);
      const d = tmpV.length(); tmpV.normalize();
      p.obj.position.addScaledVector(tmpV, p.speed * dt);
      if (p.kind === "flecha"){
        const yaw = Math.atan2(tmpV.x, tmpV.z), pitch = Math.asin(tmpV.y); p.obj.rotation.set(-pitch, yaw, 0);
      }
      if (d < 0.4){
        if (p.kind === "cura"){
          const heal = Math.floor(THREE.MathUtils.lerp(p.owner.userData.healMin, p.owner.userData.healMax, Math.random()));
          applyHeal(p.target, heal, p.obj.position);
        } else {
          const dmg = Math.floor(THREE.MathUtils.lerp(p.owner.userData.damageMin, p.owner.userData.damageMax, Math.random()));
          applyDamage(p.target, dmg, p.obj.position);
          if (p.kind === "bola"){
            enemiesOf(p.owner).forEach(e => { if (e.userData.alive && e !== p.target && e.position.distanceTo(p.obj.position) <= (p.owner.userData.splash || 1.3)){ applyDamage(e, Math.floor(dmg*0.75), p.obj.position); } });
            triggerShake(0.2, 0.12);
          }
        }
        scene.remove(p.obj); projectiles.splice(i,1);
      }
    }
  }

  // ====== Equipos (hasta 5) ======
  const TEAM_META = [
    { name:"Azul",    color:0x4a9eff },
    { name:"Rojo",    color:0xff4a4a },
    { name:"Verde",   color:0x63d471 },
    { name:"Amarillo",color:0xffd166 },
    { name:"Morado",  color:0xb78cff }
  ];
  let teams = []; // { id, name, color, units:[] }
  let allUnits = [];

  function enemiesOf(u){
    const res = [];
    for (let i=0;i<teams.length;i++){
      const t = teams[i]; if (t === u.userData.teamRef) continue;
      for (let j=0;j<t.units.length;j++){ const e = t.units[j]; if (e.userData.alive) res.push(e); }
    }
    return res;
  }
  function alliesOf(u){ return u.userData.teamRef.units; }

  function updateHPBar(u){
    const pct = clamp(u.userData.health / u.userData.maxHealth, 0, 1);
    u.userData.hpNode.userData.fg.scale.x = pct;
    u.userData.hpNode.userData.fg.position.x = (pct - 1) * 0.68;
  }
  function applyDamage(target, dmg, posForFx){
    if (!target.userData.alive) return;
    if (target.userData.type === "picaro" && Math.random() < target.userData.dodge){ spawnText(target.position, "EVA", "#a9fffe"); return; }
    target.userData.health = Math.max(0, target.userData.health - dmg);
    updateHPBar(target); spawnText(target.position, `-${dmg}`); hitSparks(posForFx || target.position.clone().setY(1.1), 0xfff1a1);
    if (target.userData.health <= 0){ target.userData.alive = false; target.visible = false; log(`${target.userData.teamRef.name} ${target.userData.name} ha caído.`); onDeath(target); }
  }
  function applyHeal(target, amount, pos){
    if (!target.userData.alive) return;
    target.userData.health = clamp(target.userData.health + amount, 0, target.userData.maxHealth);
    updateHPBar(target); spawnText(target.position, `+${amount}`, "#a8ffd9"); hitSparks(pos || target.position.clone().setY(1.1), 0xa8ffd9);
  }

  function onDeath(unit){
    updateTeamCounts();
    // comprobar victoria: cuántos equipos con vivos > 0
    const aliveTeams = teams.filter(t => t.units.some(u=>u.userData.alive));
    if (aliveTeams.length <= 1){
      simState.active = false; ui.start.disabled = false; ui.pause.disabled = true;
      const winner = aliveTeams[0];
      ui.status.textContent = winner ? `¡Gana ${winner.name}!` : "Empate";
      expandUI();
    }
  }

  function clearUnits(){ teams.forEach(t => t.units.forEach(u => scene.remove(u))); teams.forEach(t => t.units.length=0); allUnits = []; projectiles.splice(0).forEach(p => scene.remove(p.obj)); }

  function compositionFor(kind, size){
    const arr = [];
    if (kind === "balanced"){
      const base = ["guerrero","tanque","picaro","arquero","mago","sanador"];
      while (arr.length < size) arr.push(base[arr.length % base.length]);
    } else if (kind === "melee"){
      const base = ["guerrero","tanque","picaro","tanque"];
      while (arr.length < size) arr.push(base[arr.length % base.length]);
    } else if (kind === "ranged"){
      const base = ["arquero","mago","picaro","arquero"];
      while (arr.length < size) arr.push(base[arr.length % base.length]);
    } else if (kind === "support"){
      const base = ["tanque","guerrero","sanador","arquero","mago","sanador"];
      while (arr.length < size) arr.push(base[arr.length % base.length]);
    } else {
      const base = ["guerrero","tanque","picaro","arquero","mago","sanador"];
      while (arr.length < size) arr.push(randChoice(base));
    }
    return arr;
  }

  function spawnTeam(teamRef, comp){
    const list = teamRef.units;
    const center = teamRef.spawn.clone();
    const rows = Math.ceil(comp.length / 3);
    for (let i=0;i<comp.length;i++){
      const type = comp[i]; const u = makeUnit(type, teamRef.color, teamRef);
      const row = Math.floor(i / 3); const col = i % 3;
      const jitter = (Math.random()*0.8);
      let x = center.x + (col-1)*1.8 + (Math.random()*0.6);
      let z = center.z + (row-(rows-1)/2)*2.4 + jitter;
      u.position.set(x, terrain.heightAtWorld(x,z), z);
      scene.add(u); list.push(u); allUnits.push(u);
    }
  }

  function repositionTeam(teamRef){
    const list = teamRef.units;
    const center = teamRef.spawn.clone();
    const rows = Math.ceil(list.length / 3);
    for (let i=0;i<list.length;i++){
      const u = list[i];
      const row = Math.floor(i / 3);
      const col = i % 3;
      let x = center.x + (col-1)*1.8;
      let z = center.z + (row-(rows-1)/2)*2.4;
      u.position.set(x, terrain.heightAtWorld(x, z), z);
    }
  }

  function buildTeams(configs){
    const prevSpawns = teams.map(t => t.spawn);
    teams = [];
    for (let i=0;i<configs.length;i++){
      const meta = TEAM_META[i];
      const ang = i * (Math.PI*2 / configs.length);
      const defSpawn = new THREE.Vector3(Math.sin(ang)*20.0, 0, Math.cos(ang)*20.0);
      const spawn = prevSpawns[i] ? prevSpawns[i] : defSpawn;
      teams.push({ id:i, name: meta.name, color: meta.color, units: [], spawn });
    }
    // crear cada equipo con su configuración
    for (let i=0;i<teams.length;i++){
      const cfg = configs[i] || {};
      const size = clamp(parseInt(cfg.size)||8, 4, 16);
      const compKind = cfg.comp || ui.composition.value;
      const comp = compositionFor(compKind, size);
      spawnTeam(teams[i], comp);
    }
    return teams;
  }


initAI({
  THREE,
  simState,
  ui,
  teams,
  allUnits,
  clearUnits,
  buildTeams,
  updateHPBar,
  enemiesOf,
  alliesOf,
  blockedLOS,
  avoidObstacles,
  spawnProjectile,
  applyDamage,
  triggerShake,
  ground,
  crowdRepel,
  lookAt2D,
  clamp,
  ARENA_R,
  tmpV,
  refreshSpawnMarker,
  spawnEdit,
});

setupMatch();

  // ======= Bucle =======
  function updateCameraTarget(dt){
    const aliveUnits = allUnits.filter(u=>u.userData.alive);
    if (aliveUnits.length === 0) return;
    let cx=0, cz=0;
    aliveUnits.forEach(u => { cx+=u.position.x; cz+=u.position.z; });
    cx/=aliveUnits.length; cz/=aliveUnits.length;
    controls.target.lerp(new THREE.Vector3(cx, 1, cz), 0.06);
  }

  let last = performance.now();
  function frame(){
    requestAnimationFrame(frame);
    const now = performance.now();
      let dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (simState.paused) dt = 0;

      if (simState.active && !simState.paused){
        for (let i=0;i<allUnits.length;i++) decideAndMove(allUnits[i], dt);
        updateProjectiles(dt);
      }
    allUnits.forEach(ground);
    updateCameraTarget(dt); controls.update();
    allUnits.forEach(u => { u.userData && u.userData.hpNode && u.userData.hpNode.lookAt(camera.position); });
    updateFloatingTexts(dt); applyShake();
    renderer.render(scene, camera);
  }
  frame();

  // ==== Exponer debug ====
  window.debug = { obstacles, terrain, teams };

