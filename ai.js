let ctx, tmpVec1, tmpVec2;

export function initAI(c){
  ctx = c;
  const { THREE } = ctx;
  tmpVec1 = new THREE.Vector3();
  tmpVec2 = new THREE.Vector3();
}

export function updateTeamCounts(){
  const { ui, teams } = ctx;
  const box = ui.teamsPanel;
  const prevSizes = Array.from(box.querySelectorAll('input.team-size')).map(i=>parseInt(i.value));
  const prevComps = Array.from(box.querySelectorAll('select.team-comp')).map(s=>s.value);
  box.innerHTML = "";
  const tpl = document.getElementById('teamRowTemplate');
  for (let i=0;i<teams.length;i++){
    const t = teams[i];
    const total = prevSizes[i] || t.units.length;
    const compVal = prevComps[i] || ui.composition.value;
    const alive = t.units.filter(u=>u.userData.alive).length;
    const row = tpl.content.firstElementChild.cloneNode(true);
    row.querySelector('.dot').style.background = `#${t.color.toString(16).padStart(6,'0')}`;
    row.querySelector('.teamName').textContent = t.name;
    const inp = row.querySelector('.team-size');
    inp.value = total;
    inp.addEventListener('input', setupMatch);
    inp.addEventListener('change', setupMatch);
    const sel = row.querySelector('.team-comp');
    sel.value = compVal;
    sel.addEventListener('input', setupMatch);
    sel.addEventListener('change', setupMatch);
    row.querySelector('.fill').style.width = `${(100*alive/total).toFixed(1)}%`;
    row.querySelector('.team-count').textContent = `${alive}/${total}`;
    box.appendChild(row);
  }
}

export function setupMatch(){
  const { simState, ui, clearUnits, buildTeams, allUnits, updateHPBar, refreshSpawnMarker } = ctx;
  simState.active = false; simState.paused = false;
  ui.start.disabled = false; ui.pause.disabled = true; ui.pause.textContent = "Pausar"; ui.status.textContent = "Preparado.";

  const n = parseInt(ui.teamsCount.value||2);
  const inputs = ui.teamsPanel.querySelectorAll('input.team-size');
  const selects = ui.teamsPanel.querySelectorAll('select.team-comp');
  const defSize = parseInt(ui.teamSize.value||8);
  const defComp = ui.composition.value;
  const configs = [];
  for (let i=0;i<n;i++){
    const v = parseInt(inputs[i]?.value);
    const comp = selects[i]?.value;
    configs.push({
      size: isNaN(v) ? defSize : v,
      comp: comp || defComp,
    });
  }

  clearUnits();
  const newTeams = buildTeams(configs);
  ctx.teams = newTeams;
  ctx.allUnits = allUnits;
  allUnits.forEach(updateHPBar);
  updateTeamCounts();
  refreshSpawnMarker && refreshSpawnMarker();
}

export function selectTarget(u){
  const enemies = ctx.enemiesOf(u, ctx.ARENA_R * 2);
  if (enemies.length === 0) return null;
  let best = enemies[0], bestScore = Infinity;
  for (let i=0;i<enemies.length;i++){
    const e = enemies[i];
    const d = e.position.distanceTo(u.position);
    const losBlocked = ctx.blockedLOS(u.position, e.position) ? 1.25 : 1.0;
    const s = d * losBlocked * (1.0 + (e.userData.health/e.userData.maxHealth)*0.4);
    if (s < bestScore){ best = e; bestScore = s; }
  }
  return best;
}

function lowestAlly(u){
  const allies = ctx.alliesOf(u, 20).filter(a=>a.userData.alive);
  if (allies.length===0) return null;
  let best = null, bestRatio = 1e9;
  for (let i=0;i<allies.length;i++){
    const a = allies[i]; const r = a.userData.health / a.userData.maxHealth;
    if (r < bestRatio){ best = a; bestRatio = r; }
  }
  return { ally: best, ratio: bestRatio };
}

export function decideAndMove(u, dt){
  const { THREE, simState, enemiesOf, alliesOf, blockedLOS, avoidObstacles, spawnProjectile, applyDamage, triggerShake, ground, crowdRepel, lookAt2D, clamp, ARENA_R, ui, tmpV, updateIndex } = ctx;
  if (!u.userData.alive) return;
  u.userData.stateT -= dt;
  if (u.userData.stateT < 0 && u.userData.state === "flee") u.userData.state = "";
  if (u.userData.slowT > 0){
    u.userData.slowT -= dt * simState.speedMul;
    if (u.userData.slowT <= 0) u.userData.speedFactor = 1;
  }

  u.userData.retargetT -= dt;
  if (u.userData.retargetT <= 0 || !u.userData.target || !u.userData.target.userData.alive){
    u.userData.target = selectTarget(u);
    u.userData.retargetT = 0.5 + Math.random()*0.5;
  }
  const target = u.userData.target;

  const hpRatio = u.userData.health / u.userData.maxHealth;
  const nearbyEnemies = enemiesOf(u, 4.8).length;
  const nearbyAllies = alliesOf(u, 4.8).length;
  const desire = tmpVec1.set(0,0,0);

  const outnumbered = (nearbyEnemies - nearbyAllies) >= 2;
  if ((hpRatio < 0.18) || (hpRatio < 0.4 && outnumbered)){
    u.userData.state = "flee"; u.userData.stateT = 2.5 + Math.random()*1.5;
  }

  if (u.userData.state === "flee"){
    if (target){
      desire.add(tmpVec2.copy(u.position).sub(target.position).normalize().multiplyScalar(3.1));
    } else {
      const sign = Math.sign(u.userData.teamRef.units.reduce((s,x)=>s+x.position.x,0) || 1);
      desire.add(tmpVec2.set(sign,0,0));
    }
  }

  if (target){
    tmpV.copy(target.position).sub(u.position); const dist = tmpV.length(); tmpV.normalize();
    if (blockedLOS(u.position, target.position)){
      desire.add(tmpVec2.set(-tmpV.z,0,tmpV.x).multiplyScalar(0.8*(Math.random()<0.5?1:-1)));
    }
    lookAt2D(u, tmpV);

    const R = u.userData.attackRange;
    const ranged = (u.userData.type==="arquero"||u.userData.type==="mago"||u.userData.type==="lancero"||u.userData.type==="alquimista");
    const supporter = (u.userData.type==="sanador");
    const inRangeMelee = (!ranged && !supporter) && dist <= R+0.08;
    const inRangeRanged = (ranged) && dist <= R && dist >= 0.8;

    if (ranged || supporter){
      const keep = u.userData.keep || (supporter?7.0:6.2);
      const err = dist - keep;
      if (Math.abs(err) > 0.4){
        desire.add(tmpVec2.copy(tmpV).multiplyScalar(err>0 ? 0.9 : -1.0));
      }
      desire.add(tmpVec2.set(-tmpV.z,0,tmpV.x).multiplyScalar(0.4*(Math.random()<0.5?1:-1)));
    }

    if (supporter){
      const danger = enemiesOf(u, 4.5).length > 0;
      const low = lowestAlly(u);
      if (danger){
        const near = enemiesOf(u, 6);
        if (near.length){
          const nearest = near.reduce((a,b)=> (a.position.distanceTo(u.position) < b.position.distanceTo(u.position))?a:b);
          const away = tmpVec2.copy(u.position).sub(nearest.position).normalize();
          desire.add(away.multiplyScalar(1.1));
        }
      }
      if (low && low.ratio < 0.95){
        const ally = low.ally; const d = ally.position.distanceTo(u.position);
        if (d <= u.userData.healRange && u.userData.healT <= 0){ spawnProjectile(u, ally, "cura"); u.userData.healT = u.userData.healCd; }
        else { desire.add(tmpVec2.copy(ally.position).sub(u.position).normalize().multiplyScalar(0.6)); }
      }
    }

    if (!ranged && !supporter && u.userData.state !== "flee"){
      const flankBias = (u.userData.type==="picaro") ? 0.9 : 0.35;
      const flank = tmpVec2.set(-tmpV.z,0,tmpV.x).multiplyScalar(flankBias*(Math.random()<0.5?1:-1));
      if (!inRangeMelee) desire.add(tmpV).add(flank);
    }

    u.userData.attackT -= dt * simState.speedMul; u.userData.healT -= dt * simState.speedMul;
    if (u.userData.attackT <= 0 && (inRangeMelee || inRangeRanged) && !u.userData.isAttacking){
      u.userData.attackT = u.userData.attackCooldown; u.userData.isAttacking = true; u.userData.attackAnim = 0; u.userData.hitApplied = false;
      if (u.userData.type === "arquero"){ setTimeout(() => { if (u.userData.alive && target.userData.alive) spawnProjectile(u, target, "flecha"); }, 140); }
      if (u.userData.type === "mago"){ setTimeout(() => { if (u.userData.alive && target.userData.alive) spawnProjectile(u, target, "bola"); }, 220); }
      if (u.userData.type === "lancero"){ setTimeout(() => { if (u.userData.alive && target.userData.alive) spawnProjectile(u, target, "jabalina"); }, 160); }
      if (u.userData.type === "alquimista"){
        const low = lowestAlly(u);
        let potion = "veneno";
        let targ = target;
        if (low && low.ratio < 0.8 && low.ally.position.distanceTo(u.position) <= R){
          potion = "cura"; targ = low.ally;
        } else {
          const cluster = enemiesOf(u, 1.4, target.position);
          if (cluster.length >= 2) potion = "fuego";
        }
        const ptarg = targ; const ptype = potion;
        setTimeout(() => { if (u.userData.alive && ptarg.userData.alive) spawnProjectile(u, ptarg, "pocion", ptype); }, 180);
      }
    }
    if (u.userData.isAttacking){
      u.userData.attackAnim += dt * (1.0 / 0.28) * simState.speedMul; const tt = clamp(u.userData.attackAnim, 0, 1); const swing = Math.sin(tt * Math.PI);
      if (ranged || supporter){ u.userData.rightPivot.rotation.z = -swing * 0.5; u.userData.trail.material.opacity = 0; }
      else { u.userData.rightPivot.rotation.z = -swing * (u.userData.type==="tanque" ? 0.9 : 1.2); u.userData.rightPivot.rotation.x = swing * 0.25; u.userData.trail.material.opacity = (ui.showTrails.checked ? swing*0.7 : 0); }
      if (!u.userData.hitApplied && tt > 0.42 && inRangeMelee){
        u.userData.hitApplied = true;
        let dmg = Math.floor(THREE.MathUtils.lerp(u.userData.damageMin, u.userData.damageMax, Math.random()));
        if (u.userData.type === "tanque" && u.userData.aoe){
          enemiesOf(u, u.userData.aoe + 0.3, target.position).forEach(e => { applyDamage(e, dmg, tmpVec2.copy(e.position).setY(1.1)); });
          triggerShake(0.22, 0.12);
        } else {
          if (u.userData.type === "picaro"){
            const forward = tmpVec2.set(Math.sin(target.rotation.y), 0, Math.cos(target.rotation.y));
            const toAtt = tmpV.copy(u.position).sub(target.position).normalize();
            if (forward.dot(toAtt) > 0.5) dmg = Math.floor(dmg * u.userData.critBack);
          }
          applyDamage(target, dmg, tmpVec2.copy(target.position).setY(1.1)); triggerShake(0.16, 0.08);
        }
      }
      if (tt >= 1){ u.userData.isAttacking = false; u.userData.trail.material.opacity = 0; u.userData.rightPivot.rotation.set(0,0,0); }
    }
  }

  desire.add(avoidObstacles(u.position));
  if (desire.lengthSq() > 0.0001){
    desire.normalize();
    u.position.addScaledVector(desire, u.userData.speed * u.userData.speedFactor * dt * simState.speedMul);
    ground(u);
    u.userData.bobT += dt * 9 * simState.speedMul;
    const a = Math.sin(u.userData.bobT) * 0.45, b = Math.cos(u.userData.bobT) * 0.45;
    u.userData.leftPivot.rotation.x  = a * 0.25;
    u.userData.rightPivot.rotation.x = b * 0.25;
  } else {
    u.userData.leftPivot.rotation.x *= 0.8; u.userData.rightPivot.rotation.x *= 0.8;
  }
  crowdRepel(u, dt);

  const r = Math.hypot(u.position.x, u.position.z);
  if (r > ARENA_R-1.0){
    const pull = (r - (ARENA_R-1.0)); u.position.addScaledVector(tmpVec2.copy(u.position).multiplyScalar(-1/r), pull*0.7);
    ground(u);
  }
  updateIndex(u);
}

