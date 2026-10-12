/**
 * 三维视口 —— three.js 场景 / 相机 / 控制器 / 光照 / 参考基准。
 *
 * 渲染采用"按需重绘"：只有相机变化或模型重建时才 requestAnimationFrame，
 * 静止时不占用 GPU。CAD 场景绝大多数时间是静止的。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ViewDir = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' | 'isoBack';

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly root: THREE.Group;
  readonly helpers: THREE.Group;
  readonly gridGroup: THREE.Group;
  readonly planeGroup: THREE.Group;

  private container: HTMLElement;
  private needsRender = true;
  private rafId = 0;
  private running = false;
  private ro: ResizeObserver | null = null;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth || 800, container.clientHeight || 600, false);
    this.renderer.shadowMap.enabled = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xdde3ea);

    this.camera = new THREE.PerspectiveCamera(38, this.aspect(), 0.1, 20000);
    this.camera.position.set(120, 90, 150);
    this.camera.up.set(0, 0, 1); // Z 轴朝上（CAD 习惯）

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.14;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 8000;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener('change', () => this.invalidate());

    this.root = new THREE.Group();
    this.root.name = 'model';
    this.scene.add(this.root);

    this.helpers = new THREE.Group();
    this.helpers.name = 'helpers';
    this.scene.add(this.helpers);

    this.gridGroup = new THREE.Group();
    this.gridGroup.name = 'grid';
    this.helpers.add(this.gridGroup);

    this.planeGroup = new THREE.Group();
    this.planeGroup.name = 'planes';
    this.helpers.add(this.planeGroup);

    this.setupLights();
    this.setupGrid();
    this.setupBasePlanes();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);

    window.addEventListener('resize', this.onWindowResize);
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('WebGL 上下文丢失');
    });
  }

  // ---------------- 光照 ----------------
  private setupLights(): void {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a93a0, 1.15);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(180, -220, 320);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xdfe9f7, 0.85);
    fill.position.set(-260, 140, 160);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.7);
    rim.position.set(60, 320, -240);
    this.scene.add(rim);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  }

  // ---------------- 网格 ----------------
  private setupGrid(): void {
    const grid = new THREE.GridHelper(400, 40, 0xa8b4c0, 0xc7d0d9);
    // GridHelper 默认在 XZ 平面；CAD 习惯 Z 朝上，需要转到 XY 平面
    grid.rotation.x = Math.PI / 2;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.85;
    grid.name = 'gridXY';
    this.gridGroup.add(grid);
  }

  /** 三个基准面（半透明，可切换显示） */
  private setupBasePlanes(): void {
    const size = 120;
    const defs: { name: string; normal: [number, number, number]; color: number }[] = [
      { name: 'front', normal: [0, 0, 1], color: 0x4d9bf5 },
      { name: 'top', normal: [0, 1, 0], color: 0x35b26a },
      { name: 'right', normal: [1, 0, 0], color: 0xe0a020 },
    ];
    for (const d of defs) {
      const geo = new THREE.PlaneGeometry(size, size);
      const mat = new THREE.MeshBasicMaterial({
        color: d.color,
        transparent: true,
        opacity: 0.055,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      // 平面默认法向 +Z
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(...d.normal).normalize()
      );
      mesh.quaternion.copy(q);
      mesh.name = `plane_${d.name}`;
      mesh.userData.planeName = d.name;

      const border = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: d.color, transparent: true, opacity: 0.42 })
      );
      border.quaternion.copy(q);
      mesh.add(border);

      this.planeGroup.add(mesh);
    }
  }

  setPlanesVisible(v: boolean): void {
    this.planeGroup.visible = v;
  }
  setGridVisible(v: boolean): void {
    this.gridGroup.visible = v;
  }

  // ---------------- 尺寸 ----------------
  private aspect(): number {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    return w / Math.max(h, 1);
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private onWindowResize = () => this.resize();

  invalidate(): void {
    this.needsRender = true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      const damping = this.controls.enableDamping;
      if (damping) this.controls.update();
      if (this.needsRender || damping) {
        this.renderer.render(this.scene, this.camera);
        this.needsRender = false;
      }
    };
    loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  dispose(): void {
    this.stop();
    this.ro?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------------- 视图朝向 ----------------
  setView(dir: ViewDir, animate = true): void {
    const dist = this.camera.position.distanceTo(this.controls.target) || 200;
    const target = this.controls.target.clone();
    const dirs: Record<ViewDir, THREE.Vector3> = {
      front: new THREE.Vector3(0, -1, 0),
      back: new THREE.Vector3(0, 1, 0),
      right: new THREE.Vector3(1, 0, 0),
      left: new THREE.Vector3(-1, 0, 0),
      top: new THREE.Vector3(0, 0, 1),
      bottom: new THREE.Vector3(0, 0, -1),
      iso: new THREE.Vector3(1, -1, 0.85).normalize(),
      isoBack: new THREE.Vector3(-1, 1, 0.85).normalize(),
    };
    const d = dirs[dir] ?? dirs.iso;
    const pos = target.clone().addScaledVector(d, dist);

    // 上方向：俯视/仰视时用 Y 轴，否则用 Z 轴
    const up = Math.abs(d.z) > 0.98 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);

    if (!animate) {
      this.camera.up.copy(up);
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.invalidate();
      return;
    }
    this.animateCamera(pos, target, up);
  }

  private animToken = 0;
  private animateCamera(pos: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3): void {
    const token = ++this.animToken;
    const from = this.camera.position.clone();
    const fromUp = this.camera.up.clone();
    const fromTarget = this.controls.target.clone();
    const t0 = performance.now();
    const dur = 300;
    const step = () => {
      if (token !== this.animToken) return;
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
      this.camera.position.lerpVectors(from, pos, e);
      this.controls.target.lerpVectors(fromTarget, target, e);
      this.camera.up.copy(fromUp).lerp(up, e).normalize();
      this.camera.lookAt(this.controls.target);
      this.invalidate();
      if (t < 1) requestAnimationFrame(step);
    };
    step();
  }

  /** 缩放到合适大小 */
  zoomFit(box: { min: [number, number, number]; max: [number, number, number] } | null): void {
    const b = box ?? { min: [-50, -50, -50], max: [50, 50, 50] };
    const center = new THREE.Vector3(
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2
    );
    const size = new THREE.Vector3(
      Math.max(b.max[0] - b.min[0], 1e-3),
      Math.max(b.max[1] - b.min[1], 1e-3),
      Math.max(b.max[2] - b.min[2], 1e-3)
    );
    const radius = size.length() / 2;
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.35;

    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, -1, 0.85);
    dir.normalize();
    const pos = center.clone().addScaledVector(dir, dist);
    this.animateCamera(pos, center, this.camera.up.clone());
  }

  /** 屏幕坐标 → 世界射线 */
  rayFromScreen(x: number, y: number): THREE.Raycaster {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((x - rect.left) / rect.width) * 2 - 1,
      -((y - rect.top) / rect.height) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc;
  }

  /** 世界坐标 → 屏幕像素 */
  worldToScreen(p: [number, number, number]): { x: number; y: number } {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: ((v.x + 1) / 2) * rect.width,
      y: ((-v.y + 1) / 2) * rect.height,
    };
  }

  /** 相机到目标点的距离 */
  get cameraDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /** 一个像素对应多少世界单位（用于拾取容差） */
  pixelSizeAt(p: [number, number, number]): number {
    const dist = this.camera.position.distanceTo(new THREE.Vector3(p[0], p[1], p[2]));
    const h = 2 * Math.tan((this.camera.fov * Math.PI) / 360) * dist;
    return h / this.renderer.domElement.clientHeight;
  }

  /** 截图（data URL） */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
