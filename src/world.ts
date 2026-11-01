import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { FREQ_MAX, FREQ_MIN } from './story';

export type InteractId = 'monitor' | 'log' | 'transmitter';
export type ChannelState = 'idle' | 'noise' | 'locked' | 'blocked';

const AMBER = 0xffa64d;
const GREEN = 0x5dffa0;
const ROOM = { minX: -10, maxX: 10, minZ: -8, maxZ: 8, h: 5 };
const PLAYER_R = 0.35;
const EYE = 1.65;

interface Interactable {
  id: InteractId;
  hit: THREE.Mesh;
  marker: THREE.Mesh;
  label: string;
  done: boolean;
}

interface Screen {
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  state: ChannelState;
  label: string;
}

function canvasTex(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { c, ctx, tex };
}

function noiseTexture(base: [number, number, number], spread: number, repeat: number, lines = false) {
  const { c, ctx, tex } = canvasTex(256, 256);
  const img = ctx.createImageData(256, 256);
  for (let i = 0; i < 256 * 256; i++) {
    const n = (Math.random() - 0.5) * spread;
    const stain = Math.sin((i % 256) * 0.05) * Math.sin(i * 0.00009) * spread * 0.15;
    img.data[i * 4] = base[0] + n + stain;
    img.data[i * 4 + 1] = base[1] + n + stain;
    img.data[i * 4 + 2] = base[2] + n + stain;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (lines) {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    for (let p = 0; p <= 256; p += 64) {
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, 256);
      ctx.moveTo(0, p);
      ctx.lineTo(256, p);
      ctx.stroke();
    }
  }
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  void c;
  return tex;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 120);
  readonly controls: PointerLockControls;

  onTarget: (t: { id: InteractId; label: string } | null) => void = () => {};

  private clock = new THREE.Clock();
  private keys = new Set<string>();
  private velocity = new THREE.Vector3();
  private colliders: THREE.Box2[] = [];
  private interactables: Interactable[] = [];
  private raycaster = new THREE.Raycaster();
  private current: Interactable | null = null;
  private screens: Screen[] = [];
  private dial!: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture };
  private clockFace!: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture };
  private flickerLights: { light: THREE.PointLight; base: number; seed: number }[] = [];
  private leds: THREE.Mesh[] = [];
  private beacon!: THREE.Mesh;
  private txLamp!: THREE.MeshStandardMaterial;
  private frequency = 5.0;
  private locked = 0;
  private finale = 0;
  private bob = 0;
  private gameSeconds = 0;
  private screenTimer = 0;
  movementEnabled = false;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.6;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x141a20);
    this.scene.fog = new THREE.FogExp2(0x141a20, 0.03);

    this.camera.position.set(0, EYE, 6.2);
    this.camera.lookAt(0, EYE, -8);
    this.controls = new PointerLockControls(this.camera, this.renderer.domElement);

    this.build();
    this.bindKeys();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ---------------------------------------------------------------- building

  private build() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0x3a4656, 0x16110c, 1.3));

    const moon = new THREE.DirectionalLight(0x7f96b8, 1.0);
    moon.position.set(-6, 12, -20);
    s.add(moon);

    const concrete = new THREE.MeshStandardMaterial({
      map: noiseTexture([84, 82, 78], 22, 6, true),
      roughness: 0.95,
    });
    const wallMat = new THREE.MeshStandardMaterial({
      map: noiseTexture([72, 73, 70], 18, 3),
      roughness: 0.92,
    });
    const metal = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.55, metalness: 0.6 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.6, metalness: 0.5 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x3b2a1c, roughness: 0.8 });

    // floor & ceiling
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 16), concrete);
    floor.rotation.x = -Math.PI / 2;
    s.add(floor);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(20, 16), wallMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = ROOM.h;
    s.add(ceil);

    // walls (back wall has a long observation window)
    const wall = (w: number, h: number, x: number, y: number, z: number, ry: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      s.add(m);
    };
    wall(16, ROOM.h, -10, ROOM.h / 2, 0, Math.PI / 2);
    wall(16, ROOM.h, 10, ROOM.h / 2, 0, -Math.PI / 2);
    wall(20, ROOM.h, 0, ROOM.h / 2, 8, Math.PI);
    wall(20, 1.1, 0, 0.55, -8, 0); // below window
    wall(20, 1.4, 0, ROOM.h - 0.7, -8, 0); // above window
    wall(3, 2.5, -8.5, 2.35, -8, 0);
    wall(3, 2.5, 8.5, 2.35, -8, 0);
    // window mullions + glass
    for (let x = -7; x <= 7; x += 2.8) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.5, 0.15), darkMetal);
      m.position.set(x, 2.35, -8);
      s.add(m);
    }
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 2.5),
      new THREE.MeshStandardMaterial({ color: 0x223040, transparent: true, opacity: 0.18, roughness: 0.1, metalness: 0.9 }),
    );
    glass.position.set(0, 2.35, -8.02);
    s.add(glass);

    // ceiling beams + hanging fluorescent fixtures
    for (let z = -6; z <= 6; z += 4) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(20, 0.35, 0.3), metal);
      beam.position.set(0, ROOM.h - 0.18, z);
      s.add(beam);
    }
    const tubeMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xd8e6d0, emissiveIntensity: 0.0 });
    [-4, 4].forEach((x, i) => {
      const tube = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.16), tubeMat.clone());
      tube.position.set(x, ROOM.h - 0.8, 0);
      s.add(tube);
      const l = new THREE.PointLight(0xbfd4c4, 0, 12, 1.4);
      l.position.set(x, ROOM.h - 0.95, 0);
      s.add(l);
      this.flickerLights.push({ light: l, base: i === 0 ? 5 : 0, seed: 7 + i });
      (tube.material as THREE.MeshStandardMaterial).userData.light = l;
      l.userData.tube = tube.material;
    });

    // hanging amber pendant lamps
    const cordMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
    const shadeMat = new THREE.MeshStandardMaterial({ color: 0x2a241a, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide });
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffc27a, toneMapped: false });
    ([[0.5, 2.5, 13], [-4, -4.5, 21], [4, -1.5, 31]] as const).forEach(([x, z, seed]) => {
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1.2, 4), cordMat);
      cord.position.set(x, ROOM.h - 0.6, z);
      s.add(cord);
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.26, 20, 1, true), shadeMat);
      shade.position.set(x, ROOM.h - 1.3, z);
      s.add(shade);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), bulbMat);
      bulb.position.set(x, ROOM.h - 1.42, z);
      s.add(bulb);
      const l = new THREE.PointLight(AMBER, 7, 13, 1.4);
      l.position.set(x, ROOM.h - 1.5, z);
      s.add(l);
      this.flickerLights.push({ light: l, base: 7, seed });
    });

    // equipment racks along the left & back walls (decor)
    const rackGeo = new THREE.BoxGeometry(0.9, 2.3, 0.7);
    const ledGeo = new THREE.BoxGeometry(0.04, 0.04, 0.02);
    const rackSpots: [number, number, number][] = [
      [-9.5, 1.15, 5.5], [-9.5, 1.15, 4.4], [-9.5, 1.15, -6.5],
      [-3.5, 1.15, 7.5], [-2.4, 1.15, 7.5], [3, 1.15, 7.5],
    ];
    rackSpots.forEach(([x, y, z]) => {
      const rack = new THREE.Mesh(rackGeo, darkMetal);
      rack.position.set(x, y, z);
      const facingX = Math.abs(x) > 9;
      if (facingX) rack.rotation.y = Math.PI / 2;
      s.add(rack);
      this.addCollider(x, z, facingX ? 0.35 : 0.45, facingX ? 0.45 : 0.35);
      for (let k = 0; k < 10; k++) {
        const on = Math.random() > 0.4;
        const led = new THREE.Mesh(
          ledGeo,
          new THREE.MeshBasicMaterial({ color: k % 3 === 0 ? AMBER : GREEN, transparent: true, opacity: on ? 1 : 0.15 }),
        );
        const ly = 0.4 + (k % 5) * 0.32;
        const lo = -0.25 + Math.floor(k / 5) * 0.5;
        if (facingX) led.position.set(x + (x < 0 ? 0.36 : -0.36), ly, z + lo);
        else led.position.set(x + lo, ly, z - 0.36);
        s.add(led);
        this.leds.push(led);
      }
    });

    // cable runs on the floor
    const cableMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.7 });
    const cable = (pts: [number, number][]) => {
      const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0.03, z)));
      s.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 60, 0.03, 6), cableMat));
    };
    cable([[-7, -3], [-4, -1], [0, -2], [4, -3.5], [7, -5]]);
    cable([[-7, -2.6], [-5, 1], [-2, 2.5], [3, 2], [6.5, 3]]);

    // center: old swivel chair + map table
    const table = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.08, 1.4), wood);
    table.position.set(-0.5, 0.85, 0.5);
    s.add(table);
    [[-1.6, -0.1], [0.6, -0.1], [-1.6, 1.1], [0.6, 1.1]].forEach(([x, z]) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.85, 0.06), metal);
      leg.position.set(x, 0.42, z);
      s.add(leg);
    });
    this.addCollider(-0.5, 0.5, 1.25, 0.75);
    const chart = canvasTex(512, 300);
    this.drawSkyChart(chart.ctx);
    const chartMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 1.1),
      new THREE.MeshStandardMaterial({ map: chart.tex, roughness: 0.9 }),
    );
    chartMesh.rotation.x = -Math.PI / 2;
    chartMesh.rotation.z = 0.08;
    chartMesh.position.set(-0.5, 0.895, 0.5);
    s.add(chartMesh);

    // wall clock frozen near 03:17
    this.clockFace = canvasTex(256, 96);
    const clock = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 0.52),
      new THREE.MeshBasicMaterial({ map: this.clockFace.tex }),
    );
    clock.position.set(0, 3.95, -7.95);
    s.add(clock);

    this.buildMonitor(metal, darkMetal);
    this.buildLogDesk(wood, metal);
    this.buildTransmitter(metal, darkMetal);
    this.buildExterior();
  }

  private buildMonitor(metal: THREE.Material, dark: THREE.Material) {
    const s = this.scene;
    const g = new THREE.Group();
    g.position.set(-8.3, 0, -2.6);
    g.rotation.y = Math.PI / 2; // faces +x
    s.add(g);

    const desk = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.95, 1.1), dark);
    desk.position.set(0, 0.475, 0);
    g.add(desk);
    const slope = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.08, 0.6), metal);
    slope.position.set(0, 1.0, 0.25);
    slope.rotation.x = -0.3;
    g.add(slope);
    this.addCollider(-8.3, -2.6, 0.6, 1.85);

    const labels = ['CH 1 // CARRIER', 'CH 2 // BAND FILTER', 'CH 3 // TX-2 FEED'];
    [-1.15, 0, 1.15].forEach((x, i) => {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.8, 0.8), new THREE.MeshStandardMaterial({ color: 0x2b2a26, roughness: 0.7 }));
      body.position.set(x, 1.5, -0.15);
      g.add(body);
      const scr = canvasTex(256, 200);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.78, 0.6),
        new THREE.MeshBasicMaterial({ map: scr.tex, toneMapped: false }),
      );
      mesh.position.set(x, 1.52, 0.256);
      g.add(mesh);
      this.screens.push({ ctx: scr.ctx, tex: scr.tex, state: i === 0 ? 'noise' : 'idle', label: labels[i] });
    });
    // knobs
    for (let k = 0; k < 9; k++) {
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.04, 12), metal);
      knob.rotation.x = Math.PI / 2 - 0.3;
      knob.position.set(-1.5 + k * 0.37, 1.04, 0.36);
      g.add(knob);
    }
    const glow = new THREE.PointLight(GREEN, 2.2, 5, 1.8);
    glow.position.set(-7.2, 1.6, -2.6);
    s.add(glow);
    this.flickerLights.push({ light: glow, base: 2.2, seed: 3 });

    this.addInteractable('monitor', new THREE.Vector3(-7.7, 1.4, -2.6), new THREE.Vector3(1.2, 1.4, 3.6), 'Use the signal monitor');
  }

  private buildLogDesk(wood: THREE.Material, metal: THREE.Material) {
    const s = this.scene;
    const g = new THREE.Group();
    g.position.set(7.4, 0, 3.2);
    g.rotation.y = -Math.PI / 2; // faces -x
    s.add(g);
    const top = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.07, 1.0), wood);
    top.position.y = 0.8;
    g.add(top);
    [[-1, -0.42], [1, -0.42], [-1, 0.42], [1, 0.42]].forEach(([x, z]) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 0.06), metal);
      leg.position.set(x, 0.4, z);
      g.add(leg);
    });
    this.addCollider(7.4, 3.2, 0.5, 1.1);

    // the logbook (open)
    const pageTex = canvasTex(512, 320);
    this.drawLogbook(pageTex.ctx);
    const book = new THREE.Mesh(
      new THREE.PlaneGeometry(0.75, 0.47),
      new THREE.MeshStandardMaterial({ map: pageTex.tex, roughness: 0.9 }),
    );
    book.rotation.x = -Math.PI / 2;
    book.rotation.z = -0.1;
    book.position.set(0.1, 0.84, 0.05);
    g.add(book);
    const cover = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.02, 0.5), new THREE.MeshStandardMaterial({ color: 0x3a1410 }));
    cover.position.set(0.1, 0.83, 0.05);
    cover.rotation.y = -0.1;
    g.add(cover);

    // desk lamp
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.04, 16), metal);
    base.position.set(-0.75, 0.855, -0.25);
    g.add(base);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.55, 8), metal);
    arm.position.set(-0.7, 1.1, -0.2);
    arm.rotation.z = -0.35;
    g.add(arm);
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.13, 0.2, 16, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x3d3424, emissive: AMBER, emissiveIntensity: 0.25, side: THREE.DoubleSide }),
    );
    shade.position.set(-0.55, 1.36, -0.1);
    shade.rotation.z = 0.6;
    g.add(shade);
    const lamp = new THREE.PointLight(AMBER, 3.2, 5, 1.7);
    lamp.position.set(7.2, 1.3, 3.6);
    s.add(lamp);
    this.flickerLights.push({ light: lamp, base: 3.2, seed: 11 });

    this.addInteractable('log', new THREE.Vector3(7.3, 1.0, 3.2), new THREE.Vector3(1.2, 0.8, 2.3), 'Read the incident log');
  }

  private buildTransmitter(metal: THREE.Material, dark: THREE.Material) {
    const s = this.scene;
    const g = new THREE.Group();
    g.position.set(8.9, 0, -4.6);
    g.rotation.y = -Math.PI / 2;
    s.add(g);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.8, 1.0), dark);
    cab.position.y = 1.4;
    g.add(cab);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.12, 1.05), metal);
    trim.position.y = 2.86;
    g.add(trim);
    this.addCollider(8.9, -4.6, 0.55, 1.25);

    // analog dial
    this.dial = canvasTex(512, 512);
    const dialMesh = new THREE.Mesh(
      new THREE.CircleGeometry(0.42, 48),
      new THREE.MeshBasicMaterial({ map: this.dial.tex, toneMapped: false }),
    );
    dialMesh.position.set(0, 1.75, 0.505);
    g.add(dialMesh);
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.03, 8, 48), metal);
    bezel.position.copy(dialMesh.position);
    g.add(bezel);
    // tuning knob
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.1, 24), metal);
    knob.rotation.x = Math.PI / 2;
    knob.position.set(0.75, 1.1, 0.55);
    g.add(knob);
    // VU meters + lamp
    for (let i = 0; i < 2; i++) {
      const vu = new THREE.Mesh(
        new THREE.PlaneGeometry(0.34, 0.2),
        new THREE.MeshStandardMaterial({ color: 0x2a2010, emissive: AMBER, emissiveIntensity: 0.5 }),
      );
      vu.position.set(-0.8 + i * 0.4 - 0.1, 2.4, 0.505);
      g.add(vu);
    }
    this.txLamp = new THREE.MeshStandardMaterial({ color: 0x300000, emissive: 0xff3a1a, emissiveIntensity: 0.3 });
    const lampMesh = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), this.txLamp);
    lampMesh.position.set(0.8, 2.4, 0.52);
    g.add(lampMesh);
    // sealed tag
    const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.14), new THREE.MeshStandardMaterial({ color: 0xc9b98a }));
    tag.position.set(-0.75, 1.1, 0.51);
    tag.rotation.z = 0.2;
    g.add(tag);

    const glow = new THREE.PointLight(AMBER, 2.6, 6, 1.6);
    glow.position.set(7.6, 2.2, -4.6);
    s.add(glow);
    this.flickerLights.push({ light: glow, base: 2.6, seed: 5 });

    this.addInteractable('transmitter', new THREE.Vector3(8.2, 1.5, -4.6), new THREE.Vector3(1.0, 2.8, 2.6), 'Operate transmitter TX-2');
    this.drawDial();
  }

  private buildExterior() {
    const s = this.scene;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x0d0f0e, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.position.z = -60;
    s.add(ground);

    // the dish: parabola via lathe
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 24; i++) {
      const r = (i / 24) * 9;
      pts.push(new THREE.Vector2(r, (r * r) / 30));
    }
    const dishMat = new THREE.MeshStandardMaterial({ color: 0x6b6f72, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide, wireframe: false });
    const dish = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), dishMat);
    const dishGroup = new THREE.Group();
    dish.rotation.x = -0.9;
    dish.position.y = 11;
    dishGroup.add(dish);
    const ribs = new THREE.Mesh(new THREE.LatheGeometry(pts, 16), new THREE.MeshBasicMaterial({ color: 0x2c3033, wireframe: true }));
    ribs.rotation.copy(dish.rotation);
    ribs.position.copy(dish.position);
    ribs.scale.setScalar(1.005);
    dishGroup.add(ribs);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.8, 10, 8), new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.8 }));
    tower.position.y = 5;
    dishGroup.add(tower);
    // feed horn at the focal point, held by four struts from the rim
    const strutMat = new THREE.MeshStandardMaterial({ color: 0x4a4d50 });
    const focus = new THREE.Vector3(0, 7.5, 0);
    const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 1.2, 10), strutMat);
    horn.position.copy(focus);
    dish.add(horn);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const rim = new THREE.Vector3(Math.cos(a) * 8.6, 2.5, Math.sin(a) * 8.6);
      const d = new THREE.Vector3().subVectors(focus, rim);
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, d.length(), 6), strutMat);
      strut.position.copy(rim).addScaledVector(d, 0.5);
      strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
      dish.add(strut);
    }
    dishGroup.position.set(4, 0, -34);
    s.add(dishGroup);

    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 10), new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
    this.beacon.position.set(4, 16.5, -36);
    s.add(this.beacon);

    // distant pine silhouettes
    const pine = new THREE.ConeGeometry(1.4, 6, 6);
    const pineMat = new THREE.MeshStandardMaterial({ color: 0x050706, roughness: 1 });
    for (let i = 0; i < 40; i++) {
      const p = new THREE.Mesh(pine, pineMat);
      const x = (Math.random() - 0.5) * 90;
      const z = -18 - Math.random() * 45;
      if (Math.abs(x - 4) < 9 && z > -42 && z < -26) continue;
      const sc = 0.7 + Math.random() * 1.2;
      p.scale.set(sc, sc, sc);
      p.position.set(x, 3 * sc, z);
      s.add(p);
    }
  }

  // ---------------------------------------------------------------- canvases

  private drawSkyChart(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = '#b9ad8c';
    ctx.fillRect(0, 0, 512, 300);
    ctx.strokeStyle = 'rgba(40,40,30,0.5)';
    for (let i = 0; i < 512; i += 32) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 300); ctx.stroke();
    }
    for (let i = 0; i < 300; i += 32) {
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
    }
    ctx.fillStyle = '#2a2418';
    for (let i = 0; i < 160; i++) ctx.fillRect(Math.random() * 512, Math.random() * 300, 2, 2);
    ctx.strokeStyle = '#8a1d12';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(330, 140, 26, 0, Math.PI * 2); ctx.stroke();
    ctx.font = 'bold 22px monospace';
    ctx.fillStyle = '#8a1d12';
    ctx.fillText('NOT FROM HERE?', 250, 200);
    ctx.font = '16px monospace';
    ctx.fillStyle = '#2a2418';
    ctx.fillText('KESTREL RIDGE — SURVEY SECTOR 7', 16, 24);
  }

  private drawLogbook(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = '#d8ccab';
    ctx.fillRect(0, 0, 512, 320);
    ctx.fillStyle = '#b8ab88';
    ctx.fillRect(254, 0, 4, 320);
    ctx.strokeStyle = 'rgba(60,80,120,0.35)';
    for (let y = 40; y < 320; y += 18) {
      ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(502, y); ctx.stroke();
    }
    ctx.fillStyle = '#1d2238';
    ctx.font = 'italic 15px serif';
    const lines = ['14 MAR 79  03:09', 'carrier 7.317 MHz', 'bearing — INSIDE', '', '03:17  voice.', 'it is mine'];
    lines.forEach((l, i) => ctx.fillText(l, 20, 36 + i * 18));
    ctx.fillStyle = '#7a1a10';
    ctx.font = 'bold 20px serif';
    ctx.fillText('DO NOT ANSWER', 290, 120);
  }

  private drawDial() {
    const ctx = this.dial.ctx;
    const w = 512;
    const c = w / 2;
    ctx.fillStyle = '#16120b';
    ctx.fillRect(0, 0, w, w);
    const grad = ctx.createRadialGradient(c, c, 20, c, c, c);
    grad.addColorStop(0, '#3a2c14');
    grad.addColorStop(1, '#120e08');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(c, c, c, 0, Math.PI * 2); ctx.fill();
    const a0 = Math.PI * 0.8;
    const a1 = Math.PI * 2.2;
    ctx.strokeStyle = '#e7b56a';
    ctx.fillStyle = '#e7b56a';
    ctx.font = '22px monospace';
    ctx.textAlign = 'center';
    for (let f = 3; f <= 10; f += 0.25) {
      const a = a0 + ((f - FREQ_MIN) / (FREQ_MAX - FREQ_MIN)) * (a1 - a0);
      const major = Number.isInteger(f);
      ctx.lineWidth = major ? 4 : 2;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * (c - 30), c + Math.sin(a) * (c - 30));
      ctx.lineTo(c + Math.cos(a) * (c - (major ? 62 : 46)), c + Math.sin(a) * (c - (major ? 62 : 46)));
      ctx.stroke();
      if (major && f < 10) ctx.fillText(String(f), c + Math.cos(a) * (c - 92), c + Math.sin(a) * (c - 92) + 8);
    }
    const a = a0 + ((this.frequency - FREQ_MIN) / (FREQ_MAX - FREQ_MIN)) * (a1 - a0);
    ctx.strokeStyle = this.locked > 0.95 ? '#5dffa0' : '#ff6a3a';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Math.cos(a) * (c - 40), c + Math.sin(a) * (c - 40));
    ctx.stroke();
    ctx.fillStyle = '#e7b56a';
    ctx.beginPath(); ctx.arc(c, c, 14, 0, Math.PI * 2); ctx.fill();
    ctx.font = 'bold 44px monospace';
    ctx.fillStyle = this.locked > 0.95 ? '#5dffa0' : '#ffcf8a';
    ctx.fillText(`${this.frequency.toFixed(3)}`, c, c + 120);
    ctx.font = '20px monospace';
    ctx.fillText('MHz  ·  TX-2', c, c + 150);
    this.dial.tex.needsUpdate = true;
  }

  private drawScreens(t: number) {
    this.screens.forEach((scr, i) => {
      const { ctx } = scr;
      const W = 256, H = 200;
      ctx.fillStyle = '#031208';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(93,255,160,0.12)';
      ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 25) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
      ctx.fillStyle = '#5dffa0';
      ctx.font = '13px monospace';
      ctx.fillText(scr.label, 8, 16);
      const mid = H / 2 + 6;
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#7dffb4';
      ctx.shadowColor = '#5dffa0';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      for (let x = 0; x < W; x += 2) {
        let y = mid;
        if (scr.state === 'locked') {
          y += Math.sin(x * 0.09 + t * 4 + i) * 26 * (0.6 + 0.4 * Math.sin(x * 0.015 + t * 1.3));
        } else if (scr.state === 'noise') {
          y += (Math.random() - 0.5) * 50 + Math.sin(x * 0.05 + t * 9) * 6;
        } else {
          y += (Math.random() - 0.5) * 4;
        }
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.font = 'bold 13px monospace';
      const status: Record<ChannelState, string> = {
        idle: 'NO CARRIER',
        noise: 'UNDECODED // PRESS E',
        locked: 'DECODED ✓',
        blocked: 'FILTER BAND REQUIRED',
      };
      ctx.fillStyle = scr.state === 'blocked' ? '#ffb15a' : '#5dffa0';
      ctx.fillText(status[scr.state], 8, H - 10);
      // scanlines
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
      scr.tex.needsUpdate = true;
    });

    // wall clock
    const cctx = this.clockFace.ctx;
    const total = 3 * 3600 + 17 * 60 + Math.floor(this.gameSeconds);
    const hh = String(Math.floor(total / 3600) % 24).padStart(2, '0');
    const mm = String(Math.floor(total / 60) % 60).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    cctx.fillStyle = '#0b0805';
    cctx.fillRect(0, 0, 256, 96);
    cctx.font = 'bold 54px monospace';
    cctx.fillStyle = '#ff9a3a';
    cctx.shadowColor = '#ff7a1a';
    cctx.shadowBlur = 12;
    cctx.textAlign = 'center';
    cctx.fillText(`${hh}:${mm}:${ss}`, 128, 66);
    cctx.shadowBlur = 0;
    this.clockFace.tex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- helpers

  private addCollider(x: number, z: number, hx: number, hz: number) {
    this.colliders.push(new THREE.Box2(new THREE.Vector2(x - hx, z - hz), new THREE.Vector2(x + hx, z + hz)));
  }

  private addInteractable(id: InteractId, pos: THREE.Vector3, size: THREE.Vector3, label: string) {
    const hit = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.copy(pos);
    this.scene.add(hit);
    const marker = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.09),
      new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.85, toneMapped: false }),
    );
    marker.position.set(pos.x, 2.75, pos.z);
    if (id === 'transmitter') marker.position.y = 3.25;
    this.scene.add(marker);
    this.interactables.push({ id, hit, marker, label, done: false });
  }

  private bindKeys() {
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private blocked(x: number, z: number) {
    if (x < ROOM.minX + PLAYER_R || x > ROOM.maxX - PLAYER_R || z < ROOM.minZ + PLAYER_R || z > ROOM.maxZ - PLAYER_R) return true;
    return this.colliders.some(
      (b) => x > b.min.x - PLAYER_R && x < b.max.x + PLAYER_R && z > b.min.y - PLAYER_R && z < b.max.y + PLAYER_R,
    );
  }

  // ---------------------------------------------------------------- public api

  setChannel(i: number, st: ChannelState) {
    if (this.screens[i]) this.screens[i].state = st;
  }

  markDone(id: InteractId, done = true) {
    const it = this.interactables.find((x) => x.id === id);
    if (!it) return;
    it.done = done;
    (it.marker.material as THREE.MeshBasicMaterial).color.set(done ? GREEN : AMBER);
  }

  setFrequency(f: number, lock: number) {
    this.frequency = f;
    this.locked = lock;
    this.txLamp.emissiveIntensity = 0.3 + lock * 3;
    this.drawDial();
  }

  startFinale() {
    this.finale = 0.0001;
  }

  clearKeys() {
    this.keys.clear();
  }

  // ---------------------------------------------------------------- loop

  private tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    this.gameSeconds += dt;

    // movement
    if (this.movementEnabled && this.controls.isLocked) {
      const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4.2 : 2.4;
      const fwd = Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) - Number(this.keys.has('KeyS') || this.keys.has('ArrowDown'));
      const right = Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft'));
      const target = new THREE.Vector3(right, 0, fwd);
      if (target.lengthSq() > 0) target.normalize().multiplyScalar(speed);
      this.velocity.lerp(target, 1 - Math.exp(-dt * 10));

      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      dir.y = 0;
      dir.normalize();
      const side = new THREE.Vector3().crossVectors(dir, this.camera.up).normalize();
      const move = dir.multiplyScalar(this.velocity.z * dt).add(side.multiplyScalar(this.velocity.x * dt));
      const p = this.camera.position;
      if (!this.blocked(p.x + move.x, p.z)) p.x += move.x;
      if (!this.blocked(p.x, p.z + move.z)) p.z += move.z;

      const moving = this.velocity.length();
      this.bob += dt * moving * 2.6;
      p.y = EYE + Math.sin(this.bob) * 0.025 * Math.min(moving, 1);
    } else {
      this.velocity.set(0, 0, 0);
    }

    // interaction target
    let found: Interactable | null = null;
    if (this.controls.isLocked) {
      this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
      this.raycaster.far = 3.2;
      const hits = this.raycaster.intersectObjects(this.interactables.map((i) => i.hit), false);
      if (hits.length) found = this.interactables.find((i) => i.hit === hits[0].object) ?? null;
    }
    if (found !== this.current) {
      this.current = found;
      this.onTarget(found ? { id: found.id, label: found.label } : null);
    }

    // ambience
    const dim = this.finale > 0 ? Math.max(0, 1 - this.finale) : 1;
    if (this.finale > 0) this.finale += dt * 0.25;
    this.flickerLights.forEach(({ light, base, seed }) => {
      const n = Math.sin(t * 13 + seed) * Math.sin(t * 7.3 + seed * 2) * Math.sin(t * 2.1 + seed);
      let k = 1 + n * 0.12;
      if (seed === 7) k = Math.random() > 0.985 ? 0.1 : n > 0.3 ? 0.4 : 1; // dying fluorescent
      light.intensity = base * k * dim;
      const tubeMat = light.userData.tube as THREE.MeshStandardMaterial | undefined;
      if (tubeMat) tubeMat.emissiveIntensity = (light.intensity / 5) * 1.5;
    });
    if (Math.random() < 0.06) {
      const led = this.leds[(Math.random() * this.leds.length) | 0];
      const m = led.material as THREE.MeshBasicMaterial;
      m.opacity = m.opacity > 0.5 ? 0.15 : 1;
    }
    this.beacon.visible = Math.sin(t * 2.2) > 0.6;
    this.interactables.forEach((it, i) => {
      it.marker.rotation.y = t * 1.2 + i;
      it.marker.position.y += Math.sin(t * 2 + i) * 0.0015;
      (it.marker.material as THREE.MeshBasicMaterial).opacity = it === this.current ? 1 : 0.55 + Math.sin(t * 3 + i) * 0.25;
    });

    this.screenTimer += dt;
    if (this.screenTimer > 1 / 24) {
      this.screenTimer = 0;
      this.drawScreens(t);
    }

    this.renderer.render(this.scene, this.camera);
  }
}
