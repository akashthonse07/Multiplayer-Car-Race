import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const REMOTE_COLORS = [0xffdd00, 0xc0c0c0, 0xff2222, 0x0066ff];

export class Game {
  constructor({ canvas, minimap, me, token, ws, onExit, solo }) {
    this.canvas = canvas;
    this.minimap = minimap;
    this.me = me;
    this.token = token;
    this.ws = ws;
    this.onExit = onExit;
    this.solo = !!solo;
    this.dayTime = 0;
    this.cheerleaders = [];

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.composer = null;
    this.clock = new THREE.Clock();

    this.keys = {};
    this.running = false;
    this.raceStarted = false;
    this.countdownLeft = 0;
    this.finished = false;
    this.finishTime = null;
    this.raceStartTime = null;
    this.lap = 1;
    this.totalLaps = 3;
    this.progress = 0;
    this.prevProgress = 0;

    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.speed = 0;
    this.car = null;
    this.remoteCars = new Map();
    this.centerline = [];
    this.curve = null;
    this.trackWidth = 12;

    this.sendAccum = 0;
    this._onKey = this._onKey.bind(this);
    this._onResize = this._onResize.bind(this);
  }

  async init(room, countdown) {
    this.room = room;
    this.buildScene();
    this.buildTrack();
    this.buildCar();
    this.buildLights();
    this.buildPost();
    this.setupInput();
    window.addEventListener('resize', this._onResize);
    this._onResize();

    room.members.forEach(m => {
      if (m.user_id !== this.me.user_id) this.addRemoteCar(m.user_id, m.user_id);
    });

    if (this.solo) {
      for (let i = 0; i < 4; i++) this.addAICar(['Lamborghini', 'Porsche', 'Ferrari', 'Pagani'][i], i);
    }

    this.countdownLeft = countdown || 3;
    this.showCountdown(this.countdownLeft);
    const cdInterval = setInterval(() => {
      this.countdownLeft -= 1;
      if (this.countdownLeft > 0) this.showCountdown(this.countdownLeft);
      else { clearInterval(cdInterval); this.showCountdown('GO!'); this.raceStarted = true; this.raceStartTime = performance.now(); setTimeout(() => this.hideCountdown(), 800); }
    }, 1000);

    this.running = true;
    this.animate();
  }

  buildScene() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05060f, 0.012);
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
  }
  buildTrack() {
    const cps = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(50, 2, 10),
      new THREE.Vector3(100, 0, 40),
      new THREE.Vector3(110, 3, 90),
      new THREE.Vector3(60, 1, 130),
      new THREE.Vector3(0, 4, 120),
      new THREE.Vector3(-40, 1, 80),
      new THREE.Vector3(-30, 0, 30),
    ];
    this.curve = new THREE.CatmullRomCurve3(cps, true, 'centripetal', 0.5);
    const samples = 600;
    this.centerline = this.curve.getPoints(samples);
    // track length
    let len = 0;
    for (let i = 1; i < this.centerline.length; i++) len += this.centerline[i].distanceTo(this.centerline[i-1]);
    len += this.centerline[0].distanceTo(this.centerline[this.centerline.length-1]);
    this.trackLength = len;
    const half = this.trackWidth / 2;
    const verts = [];
    const idx = [];
    for (let i = 0; i < samples; i++) {
      const p = this.centerline[i];
      const t = this.curve.getTangent(i / samples);
      const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
      const left = p.clone().addScaledVector(n, half);
      const right = p.clone().addScaledVector(n, -half);
      verts.push(left.x, left.y, left.z, right.x, right.y, right.z);
    }
    for (let i = 0; i < samples; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = ((i + 1) % samples) * 2;
      const d = ((i + 1) % samples) * 2 + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a1f3a, roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide });
    const road = new THREE.Mesh(geo, mat);
    this.scene.add(road);

    const linePts = this.centerline.map(p => p.clone().add(new THREE.Vector3(0, 0.05, 0)));
    const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
    const lineMat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 2, gapSize: 2 });
    const line = new THREE.Line(lineGeo, lineMat);
    line.computeLineDistances();
    this.scene.add(line);

    const gGeo = new THREE.PlaneGeometry(600, 600);
    const gMat = new THREE.MeshStandardMaterial({ color: 0x05060f, roughness: 1 });
    const ground = new THREE.Mesh(gGeo, gMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.5;
    this.scene.add(ground);

    this.buildWalls(samples, half);
    this.buildNeon(samples);

    const sp = this.centerline[0];
    this.pos.copy(sp).add(new THREE.Vector3(0, 0, 0));
    const t0 = this.curve.getTangent(0);
    this.yaw = Math.atan2(t0.x, t0.z);
  }

  buildWalls(samples, half) {
    const wallH = 1.2;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xff2d75, emissive: 0xff2d75, emissiveIntensity: 0.4, roughness: 0.4 });
    const step = 4;
    for (let i = 0; i < samples; i += step) {
      const p = this.centerline[i];
      const t = this.curve.getTangent(i / samples);
      const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
      for (const side of [1, -1]) {
        const wp = p.clone().addScaledVector(n, side * (half + 0.3));
        wp.y = p.y + wallH / 2;
        const geo = new THREE.BoxGeometry(0.3, wallH, 2.5);
        const m = new THREE.Mesh(geo, wallMat);
        m.position.copy(wp);
        m.rotation.y = Math.atan2(t.x, t.z);
        this.scene.add(m);
      }
    }
  }

  buildNeon(samples) {
    const step = 8;
    for (let i = 0; i < samples; i += step) {
      const p = this.centerline[i];
      const t = this.curve.getTangent(i / samples);
      const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
      const side = (i % 16 === 0) ? 1 : -1;
      const lp = p.clone().addScaledVector(n, side * 9);
      lp.y = p.y;
      const poleGeo = new THREE.CylinderGeometry(0.1, 0.1, 6, 8);
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x222, metalness: 0.8 });
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.copy(lp);
      pole.position.y += 3;
      this.scene.add(pole);
      const lightGeo = new THREE.SphereGeometry(0.25, 12, 12);
      const lightMat = new THREE.MeshStandardMaterial({ color: 0x00e5ff, emissive: 0x00e5ff, emissiveIntensity: 2 });
      const bulb = new THREE.Mesh(lightGeo, lightMat);
      bulb.position.copy(lp);
      bulb.position.y += 6;
      this.scene.add(bulb);
      const pl = new THREE.PointLight(0x00e5ff, 1.2, 25);
      pl.position.copy(bulb.position);
      this.scene.add(pl);
    }
  }

  buildCar() {
    this.car = this.createCar(0xff2d75);
    this.car.position.copy(this.pos);
    this.car.rotation.y = this.yaw;
    this.scene.add(this.car);

    const spot = new THREE.SpotLight(0xffffff, 2, 40, Math.PI / 6, 0.3, 1);
    spot.position.set(0, 0.6, 2.0);
    spot.target.position.set(0, 0, 8);
    this.car.add(spot);
    this.car.add(spot.target);
  }

  createCar(color) {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.85, roughness: 0.2 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x112233, metalness: 0.9, roughness: 0.1, transparent: true, opacity: 0.55 });
    const blackMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 1, roughness: 0.2 });
    const lightW = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 3 });
    const lightR = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff2222, emissiveIntensity: 3 });

    const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.35, 4.4), bodyMat);
    chassis.position.y = 0.35;
    g.add(chassis);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.45, 3.6), bodyMat);
    upper.position.set(0, 0.75, -0.1);
    g.add(upper);
    const hood = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.12, 1.3), bodyMat);
    hood.position.set(0, 0.62, 1.5);
    g.add(hood);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.4, 1.8), glassMat);
    cabin.position.set(0, 1.05, -0.3);
    g.add(cabin);
    const rearDeck = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.15, 1.2), bodyMat);
    rearDeck.position.set(0, 0.62, -1.5);
    g.add(rearDeck);
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.06, 0.35), bodyMat);
    spoiler.position.set(0, 1.05, -2.0);
    g.add(spoiler);
    const supL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.25, 0.08), bodyMat);
    supL.position.set(-0.7, 0.9, -2.0);
    g.add(supL);
    const supR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.25, 0.08), bodyMat);
    supR.position.set(0.7, 0.9, -2.0);
    g.add(supR);

    const wGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.32, 24);
    const rimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.33, 16);
    [[-1.0, 0.38, 1.45], [1.0, 0.38, 1.45], [-1.0, 0.38, -1.45], [1.0, 0.38, -1.45]].forEach(p => {
      const tire = new THREE.Mesh(wGeo, blackMat);
      tire.rotation.z = Math.PI / 2;
      tire.position.set(p[0], p[1], p[2]);
      g.add(tire);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.rotation.z = Math.PI / 2;
      rim.position.set(p[0], p[1], p[2]);
      g.add(rim);
    });

    const hlL = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.08), lightW);
    hlL.position.set(-0.7, 0.55, 2.22);
    g.add(hlL);
    const hlR = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.08), lightW);
    hlR.position.set(0.7, 0.55, 2.22);
    g.add(hlR);
    const tlL = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.08), lightR);
    tlL.position.set(-0.7, 0.55, -2.22);
    g.add(tlL);
    const tlR = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.08), lightR);
    tlR.position.set(0.7, 0.55, -2.22);
    g.add(tlR);

    const exGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.3, 8);
    const exL = new THREE.Mesh(exGeo, rimMat);
    exL.rotation.x = Math.PI / 2;
    exL.position.set(-0.5, 0.25, -2.25);
    g.add(exL);
    const exR = new THREE.Mesh(exGeo, rimMat);
    exR.rotation.x = Math.PI / 2;
    exR.position.set(0.5, 0.25, -2.25);
    g.add(exR);

    const mL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.25), bodyMat);
    mL.position.set(-1.05, 0.95, 0.6);
    g.add(mL);
    const mR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.25), bodyMat);
    mR.position.set(1.05, 0.95, 0.6);
    g.add(mR);

    return g;
  }

  addRemoteCar(uid, label) {
    const idx = this.remoteCars.size;
    const color = REMOTE_COLORS[idx % REMOTE_COLORS.length];
    const group = this.createCar(color);
    const sp = this.centerline[0];
    group.position.copy(sp);
    group.position.x += (idx + 1) * 2.5;
    this.scene.add(group);
    this.remoteCars.set(uid, { group, target: { x: group.position.x, y: group.position.y, z: group.position.z, ry: this.yaw, speed: 0, lap: 1 }, label });
  }

  addAICar(label, idx) {
    this.addRemoteCar('AI_' + idx, label);
    const rc = this.remoteCars.get('AI_' + idx);
    if (rc) {
      rc.ai = { progress: (idx * 0.2) % 1, speed: 28 + Math.random() * 12, lap: 1 };
      rc.label = label;
    }
  }

  updateAI(dt) {
    if (!this.solo || !this.raceStarted || this.finished) return;
    const samples = this.centerline.length;
    this.remoteCars.forEach((rc) => {
      if (!rc.ai) return;
      const a = rc.ai;
      a.progress += (a.speed / this.trackLength) * dt;
      if (a.progress >= 1) { a.progress -= 1; if (a.lap < this.totalLaps) a.lap += 1; }
      const i = Math.floor(a.progress * samples) % samples;
      const p = this.centerline[i];
      const t = this.curve.getTangent(a.progress);
      rc.group.position.set(p.x, p.y, p.z);
      rc.group.rotation.y = Math.atan2(t.x, t.z);
      rc.target = { x: p.x, y: p.y, z: p.z, ry: rc.group.rotation.y, speed: a.speed, lap: a.lap };
    });
  }
  buildLights() {
    this.ambient = new THREE.AmbientLight(0x334466, 0.6);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xffeedd, 0.8);
    this.sun.position.set(50, 80, 30);
    this.scene.add(this.sun);
    this.floods = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const pl = new THREE.SpotLight(0xffffff, 1.2, 120, Math.PI / 6, 0.4, 1);
      pl.position.set(Math.cos(a) * 150, 40, Math.sin(a) * 150);
      pl.target.position.set(0, 0, 0);
      this.scene.add(pl);
      this.scene.add(pl.target);
      this.floods.push(pl);
    }
  }

  buildPost() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.9, 0.4, 0.2);
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());
  }

  setupInput() {
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);
  }
  _onKey(e) {
    this.keys[e.code] = (e.type === 'keydown');
    if (e.code === 'Space') e.preventDefault();
  }

  _onResize() {
    if (!this.camera) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.composer) this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  roadHeight(x, z) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.centerline.length; i++) {
      const p = this.centerline[i];
      const dx = p.x - x, dz = p.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return this.centerline[best].y;
  }

  nearestIndex(x, z) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.centerline.length; i++) {
      const p = this.centerline[i];
      const dx = p.x - x, dz = p.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  updatePhysics(dt) {
    if (!this.raceStarted || this.finished) {
      this.car.position.y = this.roadHeight(this.car.position.x, this.car.position.z);
      this.car.rotation.y = this.yaw;
      return;
    }
    const throttle = (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0);
    const steer = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0);
    const handbrake = this.keys['Space'];

    const maxSpeed = 45;
    const accel = 18;
    const brake = 30;
    const friction = 8;

    if (throttle > 0) this.speed += accel * dt;
    else if (throttle < 0) this.speed -= brake * dt;
    else {
      if (this.speed > 0) this.speed = Math.max(0, this.speed - friction * dt);
      else if (this.speed < 0) this.speed = Math.min(0, this.speed + friction * dt);
    }
    if (handbrake) this.speed *= 0.95;
    this.speed = Math.max(-10, Math.min(maxSpeed, this.speed));

    const steerFactor = 1 - Math.min(Math.abs(this.speed) / maxSpeed, 0.7) * 0.5;
    const steerAngle = steer * 0.6 * steerFactor;
    this.yaw += steerAngle * (this.speed / 8) * dt;

    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    this.pos.x = this.car.position.x;
    this.pos.z = this.car.position.z;
    this.pos.x += fx * this.speed * dt;
    this.pos.z += fz * this.speed * dt;

    const idx = this.nearestIndex(this.pos.x, this.pos.z);
    const cp = this.centerline[idx];
    const t = this.curve.getTangent(idx / this.centerline.length);
    const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
    const lateral = (this.pos.x - cp.x) * n.x + (this.pos.z - cp.z) * n.z;
    const half = this.trackWidth / 2 + 0.5;
    if (Math.abs(lateral) > half) {
      const sign = Math.sign(lateral);
      this.pos.x -= n.x * (Math.abs(lateral) - half) * sign;
      this.pos.z -= n.z * (Math.abs(lateral) - half) * sign;
      this.speed *= 0.5;
    }

    const y = this.roadHeight(this.pos.x, this.pos.z);
    this.car.position.set(this.pos.x, y, this.pos.z);
    this.car.rotation.y = this.yaw;

    const newIdx = this.nearestIndex(this.pos.x, this.pos.z);
    this.progress = newIdx / this.centerline.length;
    if (this.prevProgress > 0.8 && this.progress < 0.2) {
      if (this.lap < this.totalLaps) this.lap += 1;
      else if (!this.finished) this.finishRace();
    }
    this.prevProgress = this.progress;

    const speedKmh = Math.abs(this.speed) * 3.6;
    const sv = document.getElementById('speed-val');
    if (sv) sv.textContent = Math.round(speedKmh);
    const lv = document.getElementById('lap-val');
    if (lv) lv.textContent = Math.min(this.lap, this.totalLaps);

    this.sendAccum += dt;
    if (!this.solo && this.sendAccum > 0.05 && this.ws && this.ws.readyState === 1) {
      this.sendAccum = 0;
      this.ws.send(JSON.stringify({
        type: 'pos',
        x: this.car.position.x, y: this.car.position.y, z: this.car.position.z,
        rx: this.car.rotation.x, ry: this.car.rotation.y, rz: this.car.rotation.z,
        speed: this.speed, lap: this.lap
      }));
    }
  }

  updateRemote(dt) {
    this.remoteCars.forEach((rc) => {
      const t = rc.target;
      rc.group.position.x += (t.x - rc.group.position.x) * 0.25;
      rc.group.position.y += (t.y - rc.group.position.y) * 0.25;
      rc.group.position.z += (t.z - rc.group.position.z) * 0.25;
      let dy = t.ry - rc.group.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      rc.group.rotation.y += dy * 0.25;
    });
  }

  updateCamera() {
    const offset = new THREE.Vector3(0, 4, -9);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    const desired = this.car.position.clone().add(offset);
    this.camera.position.lerp(desired, 0.1);
    const look = this.car.position.clone().add(new THREE.Vector3(Math.sin(this.yaw) * 5, 1, Math.cos(this.yaw) * 5));
    this.camera.lookAt(look);
  }

  showCountdown(txt) {
    const el = document.getElementById('countdown');
    if (el) { el.classList.remove('hidden'); el.textContent = txt; }
  }
  hideCountdown() {
    const el = document.getElementById('countdown');
    if (el) el.classList.add('hidden');
  }

  finishRace() {
    this.finished = true;
    this.finishTime = (performance.now() - this.raceStartTime) / 1000;
    const rs = document.getElementById('race-status');
    if (rs) rs.textContent = `Finished! ${this.finishTime.toFixed(2)}s`;
    if (!this.solo) {
      fetch('/api/rooms/' + this.room.code + '/finish?time=' + this.finishTime + '&token=' + encodeURIComponent(this.token), { method: 'POST' }).catch(() => {});
    }
  }

  onRemotePos(msg) {
    if (!this.remoteCars.has(msg.user_id)) this.addRemoteCar(msg.user_id, msg.user_id);
    const rc = this.remoteCars.get(msg.user_id);
    if (rc) {
      rc.target = { x: msg.x, y: msg.y, z: msg.z, ry: msg.ry, speed: msg.speed, lap: msg.lap };
    }
  }

  appendChat(who, text) {
    const log = document.getElementById('game-chat-log');
    if (!log) return;
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML = `<span class="who">${who}:</span> ${escapeHtmlGame(text)}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  onRaceFinish(msg) {
    const rs = document.getElementById('race-status');
    if (rs) rs.textContent = `${msg.username} finished in ${Number(msg.time).toFixed(2)}s`;
  }

  updatePositionsHUD() {
    const el = document.getElementById('positions');
    if (!el) return;
    const rows = [];
    rows.push({ name: this.me.username, lap: this.lap, me: true });
    this.remoteCars.forEach((rc, uid) => {
      rows.push({ name: rc.label || uid, lap: rc.target ? rc.target.lap : 1, me: false });
    });
    rows.sort((a, b) => b.lap - a.lap);
    el.innerHTML = rows.map((r, i) => `<div class="posrow ${r.me ? 'me' : ''}"><span>${i + 1}. ${r.name}</span><span>Lap ${r.lap}</span></div>`).join('');
  }

  drawMinimap() {
    const c = this.minimap;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
    this.centerline.forEach(p => { minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); minz = Math.min(minz, p.z); maxz = Math.max(maxz, p.z); });
    const sx = (maxx - minx) || 1, sz = (maxz - minz) || 1;
    const s = Math.min(c.width / sx, c.height / sz) * 0.8;
    const ox = (c.width - sx * s) / 2 - minx * s;
    const oz = (c.height - sz * s) / 2 - minz * s;
    ctx.strokeStyle = '#2a3560';
    ctx.lineWidth = 2;
    ctx.beginPath();
    this.centerline.forEach((p, i) => {
      const x = p.x * s + ox;
      const y = p.z * s + oz;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
    const drawDot = (x, z, color) => {
      const px = x * s + ox, py = z * s + oz;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
    };
    drawDot(this.car.position.x, this.car.position.z, '#ff2d75');
    this.remoteCars.forEach((rc) => drawDot(rc.group.position.x, rc.group.position.z, '#00e5ff'));
  }

  animate() {
    if (!this.running) return;
    requestAnimationFrame(() => this.animate());
    const dt = Math.min(this.clock.getDelta(), 0.05);


    // crowd bob
    if (this.crowd) {
      // subtle: no per-instance update for perf
    }
    this.updatePhysics(dt);
    this.updateAI(dt);
    this.updateRemote(dt);
    this.updateCamera();
    this.updatePositionsHUD();
    this.drawMinimap();
    if (this.composer) this.composer.render();
  }


  exit() {
    this.running = false;
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKey);
    window.removeEventListener('resize', this._onResize);
    if (this.renderer) this.renderer.dispose();
    if (this.onExit) this.onExit();
  }


  dispose() { this.exit(); }
}


function escapeHtmlGame(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
