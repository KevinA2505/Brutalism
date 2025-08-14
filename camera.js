export function initCamera(renderer, canvas, simState){
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 6000);
  const SATELLITE = { r: 66, phi: 0.62 };
  camera.position.set(0, 38, 56);
  const tmpTargetPos = new THREE.Vector3();
  const controls = {
    satellite: true,
    target: new THREE.Vector3(0, 1, 0),
    spherical: { r: SATELLITE.r, phi: SATELLITE.phi, theta: 0 },
    dragging: false, button: 0, lastX: 0, lastY: 0,
    panX: 0, panY: 0, rotVelTheta: 0, rotVelPhi: 0,
    inertia: 0.92, sensitivity: 0.006,
    zoom(delta){
      const minR = this.satellite ? 32 : 10;
      const maxR = this.satellite ? 130 : 130;
      this.spherical.r = Math.min(maxR, Math.max(minR, this.spherical.r * (delta>0 ? 1.1: 0.9)));
    },
    rotate(dx, dy, speedMul, boost){
      const sens = this.sensitivity * (boost ? 1.9 : 1.0);
      this.rotVelTheta -= dx * sens;
      this.rotVelPhi   -= dy * sens * 0.85;
      this.spherical.theta += this.rotVelTheta * speedMul;
      this.spherical.phi   += this.rotVelPhi   * speedMul;
      const minPhi = 0.38, maxPhi = 1.2;
      this.spherical.phi = Math.min(maxPhi, Math.max(minPhi, this.spherical.phi));
    },
    pan(dx, dy){
      const panSpeed = 0.014 * this.spherical.r;
      this.panX += -dx * panSpeed;
      this.panY +=  dy * panSpeed;
    },
    update(){
      if (this.satellite) this.spherical.theta += 0.0015 * simState.speedMul;
      else if (!this.dragging){
        this.spherical.theta += this.rotVelTheta;
        this.spherical.phi   += this.rotVelPhi;
        this.rotVelTheta *= this.inertia;
        this.rotVelPhi   *= this.inertia * 0.96;
      }
      const r = this.spherical.r;
      const x = r * Math.sin(this.spherical.phi) * Math.sin(this.spherical.theta);
      const y = r * Math.cos(this.spherical.phi);
      const z = r * Math.sin(this.spherical.phi) * Math.cos(this.spherical.theta);
      const targetPos = tmpTargetPos.set(x + this.panX, y + this.panY + 1, z);
      camera.position.lerp(targetPos, 0.2);
      camera.lookAt(this.target.x + this.panX, this.target.y + this.panY, this.target.z);
    }
  };

  function onResize(){
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  window.addEventListener('resize', onResize);
  window.addEventListener('wheel', (e) => { e.preventDefault(); controls.zoom(e.deltaY); }, { passive: false });
  window.addEventListener('mousedown', (e) => {
    const overUI = !!e.target.closest('.panel'); if (overUI) return;
    controls.dragging = true; controls.button = e.button;
    controls.lastX = e.clientX; controls.lastY = e.clientY;
    if (e.target === canvas){ canvas.requestPointerLock && canvas.requestPointerLock(); }
  });
  window.addEventListener('mouseup', () => { controls.dragging = false; document.exitPointerLock && document.exitPointerLock(); });
  window.addEventListener('mousemove', (e) => {
    if (!controls.dragging) return;
    let dx = e.movementX ?? (e.clientX - controls.lastX);
    let dy = e.movementY ?? (e.clientY - controls.lastY);
    controls.lastX = e.clientX; controls.lastY = e.clientY;
    if (controls.button === 0) controls.rotate(dx, dy, 1.0, e.shiftKey);
    if (controls.button === 2) controls.pan(dx, dy);
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  return { camera, controls };
}

