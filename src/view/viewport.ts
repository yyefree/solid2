/**
 * 三维视口 —— three.js 场景 / 相机 / 控制器 / 光照 / 参考基准。
 *
 * 渲染采用"按需重绘"：只有相机变化或模型重建时才 requestAnimationFrame，
 * 静止时不占用 GPU。CAD 场景绝大多数时间是静止的。
 *
 * 鼠标映射遵循 SolidWorks 默认约定：
 *   中键拖动        → 旋转视图
 *   Ctrl + 中键拖动 → 平移视图
 *   Shift + 中键拖动→ 缩放视图
 *   滚轮            → 缩放视图
 *   右键拖动        → 鼠标手势（由 UI 层接管，这里不处理）
 *   右键单击        → 上下文菜单（由 UI 层接管）
 *   左键            → 选择
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ViewDir = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' | 'isoBack';
export type ProjectionMode = 'perspective' | 'orthographic';
export type SceneName = '默认' | '单色灰' | '深色' | '白色';

interface ViewSnapshot {
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  zoom: number;
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly root: THREE.Group;
  readonly helpers: THREE.Group;
  readonly gridGroup: THREE.Group;
  readonly planeGroup: THREE.Group;
  readonly controls: OrbitControls;

  private readonly camPersp: THREE.PerspectiveCamera;
  private readonly camOrtho: THREE.OrthographicCamera;
  private mode: ProjectionMode = 'perspective';

  /** 当前激活的相机（透视 / 正投影可切换） */
  get camera(): THREE.Camera {
    return this.mode === 'perspective' ? this.camPersp : this.camOrtho;
  }
  /** 透视相机（缩放、视角计算用） */
  get persp(): THREE.PerspectiveCamera {
    return this.camPersp;
  }
  get projection(): ProjectionMode {
    return this.mode;
  }

  private container: HTMLElement;
  private needsRender = true;
  private rafId = 0;
  private running = false;
  private ro: ResizeObserver | null = null;

  /** 视图历史（「上一视图」用） */
  private viewStack: ViewSnapshot[] = [];
  private suppressHistory = false;

  /** 剖面视图：全局裁剪平面（null = 关闭） */
  private clipPlane: THREE.Plane | null = null;

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
    this.scene.background = makeGradientTexture(['#dfe8f2', '#f2f6fa', '#c9d6e4']);

    this.camPersp = new THREE.PerspectiveCamera(38, this.aspect(), 0.1, 20000);
    this.camPersp.position.set(120, 90, 150);
    this.camPersp.up.set(0, 0, 1); // Z 轴朝上（CAD 习惯）

    this.camOrtho = new THREE.OrthographicCamera(-100, 100, 100, -100, -5000, 20000);
    this.camOrtho.position.copy(this.camPersp.position);
    this.camOrtho.up.copy(this.camPersp.up);

    this.controls = new OrbitControls(this.camPersp, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.14;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 8000;
    // SolidWorks 约定：中键旋转；Ctrl/Shift + 中键 由 onPointerDownCapture 动态改写
    this.controls.mouseButtons = {
      LEFT: null as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: null as unknown as THREE.MOUSE,
    };
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener('change', () => this.invalidate());
    this.controls.addEventListener('end', () => this.rememberView());

    // 中键 + 修饰键 → 平移 / 缩放（必须在 OrbitControls 之前改写）
    this.renderer.domElement.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 1) return;
        const mb = this.controls.mouseButtons;
        if (e.ctrlKey || e.metaKey) mb.MIDDLE = THREE.MOUSE.PAN;
        else if (e.shiftKey) mb.MIDDLE = THREE.MOUSE.DOLLY;
        else mb.MIDDLE = THREE.MOUSE.ROTATE;
      },
      { capture: true }
    );

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
    this.camPersp.aspect = w / h;
    this.camPersp.updateProjectionMatrix();
    this.syncOrthoFrustum();
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

  // ---------------- 显示模式 / 布景 / 剖面 ----------------
  /** 透视 / 正投影（SolidWorks「显示模式」） */
  setProjection(mode: ProjectionMode): void {
    if (this.mode === mode) return;
    const pos = this.camera.position.clone();
    const up = this.camera.up.clone();
    this.mode = mode;
    const cam = this.camera;
    cam.position.copy(pos);
    cam.up.copy(up);
    if (mode === 'orthographic') this.syncOrthoFrustum();
    this.controls.object = cam;
    this.controls.update();
    this.invalidate();
  }

  /** 正投影视锥随当前相机距离与视口尺寸自适应，观感与透视一致 */
  private syncOrthoFrustum(): void {
    const dist = this.camPersp.position.distanceTo(this.controls.target) || 200;
    const h = 2 * Math.tan((this.camPersp.fov * Math.PI) / 360) * dist;
    const w = h * this.aspect();
    const cam = this.camOrtho;
    cam.left = -w / 2;
    cam.right = w / 2;
    cam.top = h / 2;
    cam.bottom = -h / 2;
    cam.updateProjectionMatrix();
  }

  /** 应用布景（背景） */
  setScene(name: SceneName): void {
    const presets: Record<SceneName, string[]> = {
      默认: ['#dfe8f2', '#f2f6fa', '#c9d6e4'],
      单色灰: ['#d9dde2', '#e6e9ed', '#cfd4da'],
      深色: ['#2b3644', '#3a4756', '#232c37'],
      白色: ['#ffffff', '#ffffff', '#f5f7f9'],
    };
    this.scene.background = makeGradientTexture(presets[name] ?? presets['默认']);
    this.invalidate();
  }

  /**
   * 剖面视图：用一个轴对齐平面剖开模型。
   * @param axis 'none' 关闭；'x'/'y'/'z' 以该轴法向剖切
   * @param offset 相对包围盒中心的偏移（世界单位）
   */
  setSection(axis: 'none' | 'x' | 'y' | 'z', offset = 0, box?: { min: [number, number, number]; max: [number, number, number] } | null): void {
    if (axis === 'none') {
      this.clipPlane = null;
      this.renderer.clippingPlanes = [];
      this.renderer.localClippingEnabled = false;
      this.invalidate();
      return;
    }
    const b = box ?? { min: [-50, -50, -50], max: [50, 50, 50] };
    const c: [number, number, number] = [
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2,
    ];
    const n = axis === 'x' ? new THREE.Vector3(-1, 0, 0) : axis === 'y' ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 0, -1);
    const point = new THREE.Vector3(c[0], c[1], c[2]).addScaledVector(n, -offset);
    this.clipPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, point);
    this.renderer.clippingPlanes = [this.clipPlane];
    this.renderer.localClippingEnabled = true;
    this.invalidate();
  }

  get sectionEnabled(): boolean {
    return !!this.clipPlane;
  }

  // ---------------- 视图历史 ----------------
  /** 记录一次视图（相机停止运动后自动调用） */
  private rememberView(): void {
    if (this.suppressHistory) return;
    const snap = this.snapshotView();
    const last = this.viewStack[this.viewStack.length - 1];
    if (last && last.position.distanceToSquared(snap.position) < 1e-6 && last.target.distanceToSquared(snap.target) < 1e-6) {
      return;
    }
    this.viewStack.push(snap);
    if (this.viewStack.length > 30) this.viewStack.shift();
  }

  private snapshotView(): ViewSnapshot {
    return {
      position: this.camera.position.clone(),
      target: this.controls.target.clone(),
      up: this.camera.up.clone(),
      zoom: this.camPersp.zoom,
    };
  }

  get hasPrevView(): boolean {
    return this.viewStack.length > 1;
  }

  /** 上一视图（SolidWorks 视图工具栏） */
  prevView(): boolean {
    if (this.viewStack.length < 2) return false;
    this.viewStack.pop(); // 当前视图
    const v = this.viewStack[this.viewStack.length - 1];
    this.suppressHistory = true;
    this.camPersp.position.copy(v.position);
    this.camOrtho.position.copy(v.position);
    this.controls.target.copy(v.target);
    this.camPersp.up.copy(v.up);
    this.camOrtho.up.copy(v.up);
    this.camPersp.zoom = v.zoom;
    this.camPersp.updateProjectionMatrix();
    this.syncOrthoFrustum();
    this.controls.update();
    this.suppressHistory = false;
    this.invalidate();
    return true;
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
      this.camPersp.up.copy(up);
      this.camPersp.position.copy(pos);
      this.camOrtho.up.copy(up);
      this.camOrtho.position.copy(pos);
      this.controls.target.copy(target);
      this.syncOrthoFrustum();
      this.controls.update();
      this.rememberView();
      this.invalidate();
      return;
    }
    this.animateCamera(pos, target, up);
  }

  /** 正视于：把相机摆到指定法向，用于「正视于」命令 */
  normalTo(normal: [number, number, number], point: [number, number, number], up?: [number, number, number]): void {
    const dist = this.camera.position.distanceTo(this.controls.target) || 200;
    const n = new THREE.Vector3(...normal).normalize();
    const t = new THREE.Vector3(...point);
    const pos = t.clone().addScaledVector(n, dist);
    const u = up ? new THREE.Vector3(...up) : new THREE.Vector3(0, 0, 1);
    this.animateCamera(pos, t, u);
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
      const p = new THREE.Vector3().lerpVectors(from, pos, e);
      this.camPersp.position.copy(p);
      this.camOrtho.position.copy(p);
      this.controls.target.lerpVectors(fromTarget, target, e);
      const u = fromUp.clone().lerp(up, e).normalize();
      this.camPersp.up.copy(u);
      this.camOrtho.up.copy(u);
      this.camera.lookAt(this.controls.target);
      this.invalidate();
      if (t < 1) requestAnimationFrame(step);
      else this.rememberView();
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
    const fov = (this.camPersp.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.35;

    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, -1, 0.85);
    dir.normalize();
    const pos = center.clone().addScaledVector(dir, dist);
    this.animateCamera(pos, center, this.camera.up.clone());
  }

  /** 按系数缩放（>1 拉近，<1 推远） */
  zoomBy(factor: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const dist = offset.length();
    const next = THREE.MathUtils.clamp(dist / factor, this.controls.minDistance, this.controls.maxDistance);
    const pos = this.controls.target.clone().addScaledVector(offset.normalize(), next);
    this.camPersp.position.copy(pos);
    this.camOrtho.position.copy(pos);
    this.syncOrthoFrustum();
    this.controls.update();
    this.rememberView();
    this.invalidate();
  }

  /** 缩放至区域：把屏幕矩形框内的内容放大铺满视口 */
  zoomArea(rect: { x: number; y: number; w: number; h: number }): void {
    const el = this.renderer.domElement;
    const W = el.clientWidth || 1;
    const H = el.clientHeight || 1;
    if (rect.w < 6 || rect.h < 6) return;

    const viewDir = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewDir, this.controls.target);

    const corner = (sx: number, sy: number): THREE.Vector3 | null => {
      const rc = this.rayFromScreen(rect.x + sx, rect.y + sy);
      const hit = new THREE.Vector3();
      return rc.ray.intersectPlane(plane, hit) ? hit : null;
    };
    const pts = [corner(0, 0), corner(rect.w, 0), corner(0, rect.h), corner(rect.w, rect.h)].filter(
      (p): p is THREE.Vector3 => !!p
    );
    if (pts.length < 2) return;

    const center = new THREE.Vector3();
    for (const p of pts) center.add(p);
    center.multiplyScalar(1 / pts.length);

    const right = new THREE.Vector3().crossVectors(viewDir, this.camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, viewDir).normalize();
    let halfW = 0;
    let halfH = 0;
    for (const p of pts) {
      const d = p.clone().sub(center);
      halfW = Math.max(halfW, Math.abs(d.dot(right)));
      halfH = Math.max(halfH, Math.abs(d.dot(up)));
    }
    const fov = (this.camPersp.fov * Math.PI) / 180;
    const distH = halfH / Math.tan(fov / 2);
    const distW = halfW / (Math.tan(fov / 2) * (W / H));
    const dist = Math.max(distH, distW) * 1.06;

    const pos = center.clone().addScaledVector(viewDir, -dist);
    this.animateCamera(pos, center, this.camera.up.clone());
  }

  /**
   * 绕视点旋转视图（方向键用）。
   * @param yawDeg 水平角（绕相机 up 轴）
   * @param pitchDeg 俯仰角（绕相机 right 轴）
   */
  rotateView(yawDeg: number, pitchDeg = 0): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const upAxis = this.camera.up.clone().normalize();
    if (yawDeg) offset.applyAxisAngle(upAxis, (yawDeg * Math.PI) / 180);
    if (pitchDeg) {
      const right = new THREE.Vector3().crossVectors(offset, upAxis).normalize();
      if (right.lengthSq() > 1e-9) {
        const before = offset.clone().applyAxisAngle(right, (pitchDeg * Math.PI) / 180);
        // 防止翻过极点：与 up 轴的夹角保持在 [3°, 177°]
        const cos = before.clone().normalize().dot(upAxis);
        const ang = Math.acos(THREE.MathUtils.clamp(cos, -1, 1));
        const lim = (3 * Math.PI) / 180;
        if (ang > lim && ang < Math.PI - lim) offset.copy(before);
      }
    }
    const pos = this.controls.target.clone().add(offset);
    this.camPersp.position.copy(pos);
    this.camOrtho.position.copy(pos);
    this.camera.lookAt(this.controls.target);
    this.syncOrthoFrustum();
    this.controls.update();
    this.rememberView();
    this.invalidate();
  }

  /** 平移视图（Ctrl+方向键用），比例 = 屏幕宽度的 10% */
  panView(dxScreenFrac: number, dyScreenFrac: number): void {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const h = 2 * Math.tan((this.camPersp.fov * Math.PI) / 360) * dist;
    const w = h * this.aspect();
    const viewDir = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).normalize();
    const right = new THREE.Vector3().crossVectors(viewDir, this.camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, viewDir).normalize();
    const delta = new THREE.Vector3()
      .addScaledVector(right, -dxScreenFrac * w)
      .addScaledVector(up, dyScreenFrac * h);
    this.controls.target.add(delta);
    this.camPersp.position.add(delta);
    this.camOrtho.position.add(delta);
    this.controls.update();
    this.rememberView();
    this.invalidate();
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
    const h = 2 * Math.tan((this.camPersp.fov * Math.PI) / 360) * dist;
    return h / this.renderer.domElement.clientHeight;
  }

  /** 相机朝向的粗略名称（状态栏显示用） */
  viewName(): string {
    const d = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    const ax = Math.abs(d.x);
    const ay = Math.abs(d.y);
    const az = Math.abs(d.z);
    const near = (a: number, b: number) => Math.abs(a - b) < 0.16;
    if (near(ax, ay) && near(ay, az)) return d.z > 0 ? '等轴测' : '等轴测（后）';
    if (ax > ay && ax > az) return d.x > 0 ? '右视' : '左视';
    if (ay > ax && ay > az) return d.y > 0 ? '后视' : '前视';
    return d.z > 0 ? '俯视' : '仰视';
  }

  /** 截图（data URL） */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

/** 生成竖向渐变贴图，用作 scene.background（SolidWorks 式布景） */
function makeGradientTexture(colors: string[]): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  const stops = colors.length === 1 ? [colors[0], colors[0]] : colors;
  stops.forEach((col, i) => g.addColorStop(i / (stops.length - 1), col));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
