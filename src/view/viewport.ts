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
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { el, clear } from '../ui/dom';

export type ViewDir = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' | 'isoBack';
export type ProjectionMode = 'perspective' | 'orthographic';
export type SceneName = '默认' | '单色灰' | '深色' | '白色';
export type LightPresetName = '默认' | '明亮' | '柔和' | '顶光' | '背光';

/** 视口布局（SolidWorks：视图 → 显示 → 视口） */
export type LayoutName = 'single' | 'twoH' | 'twoV' | 'quad';

export interface LayoutDef {
  id: LayoutName;
  label: string;
  /** 每个格子的默认朝向（SW 4 视图默认：前视/上视/右视/等轴测） */
  dirs: ViewDir[];
}

/** 布局定义（ribbon 视图页签与视图菜单共用） */
export const LAYOUT_DEFS: LayoutDef[] = [
  { id: 'single', label: '单视图', dirs: ['iso'] },
  { id: 'twoH', label: '双视图 · 水平', dirs: ['front', 'iso'] },
  { id: 'twoV', label: '双视图 · 垂直', dirs: ['top', 'iso'] },
  { id: 'quad', label: '四视图', dirs: ['front', 'top', 'right', 'iso'] },
];

/** 视口格矩形（CSS 像素，左上角原点，y 向下） */
interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 标准视图朝向 → [相机方向, 上方向] */
export const VIEW_DIRS: Record<ViewDir, { dir: [number, number, number]; up: [number, number, number] }> = {
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, 1, 0] },
  iso: { dir: [1, -1, 0.85], up: [0, 0, 1] },
  isoBack: { dir: [-1, 1, 0.85], up: [0, 0, 1] },
};

/** 中国语视图名（视口标签 / 状态栏用） */
const VIEW_NAMES: Record<ViewDir, string> = {
  front: '前视',
  back: '后视',
  left: '左视',
  right: '右视',
  top: '俯视',
  bottom: '仰视',
  iso: '等轴测',
  isoBack: '等轴测（后）',
};

/** 光源预设名列表（Heads-up「光源」下拉按此渲染） */
export const LIGHT_PRESET_NAMES: LightPresetName[] = ['默认', '明亮', '柔和', '顶光', '背光'];

/** 每项 = [强度, 位置] */
type LightSpec = [number, [number, number, number]];

interface LightPreset {
  hemi: number;
  key: LightSpec;
  fill: LightSpec;
  rim: LightSpec;
}

/** 构造预设并锁住元组类型（否则数组字面量会被推断成 (number|number[])[]） */
const lp = (hemi: number, key: LightSpec, fill: LightSpec, rim: LightSpec): LightPreset => ({
  hemi,
  key,
  fill,
  rim,
});

const LIGHT_PRESETS: Record<LightPresetName, LightPreset> = {
  默认: lp(1.15, [2.1, [180, -220, 320]], [0.85, [-260, 140, 160]], [0.7, [60, 320, -240]]),
  明亮: lp(1.6, [2.8, [180, -220, 320]], [1.2, [-260, 140, 160]], [0.95, [60, 320, -240]]),
  柔和: lp(1.05, [1.2, [180, -220, 320]], [0.7, [-260, 140, 160]], [0.35, [60, 320, -240]]),
  顶光: lp(0.9, [2.4, [0, 0, 420]], [0.55, [-200, -160, 120]], [0.45, [0, 260, -180]]),
  背光: lp(1.0, [1.2, [160, -200, 260]], [0.6, [-240, 120, 140]], [1.7, [-40, 240, -320]]),
};

interface ViewSnapshot {
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  zoom: number;
}

/**
 * 一个视口格（多视口布局时每格独立的一套相机 + 视图目标 + 视图历史）。
 * 单视图布局下视口里只有一格，全部旧 API 语义不变。
 */
export class ViewCell {
  readonly persp: THREE.PerspectiveCamera;
  readonly ortho: THREE.OrthographicCamera;
  mode: ProjectionMode = 'perspective';
  /** OrbitControls 的目标点对象（直接交给 controls.target，pan/zoom 原地改它） */
  readonly target = new THREE.Vector3();
  /** 视图历史（「上一视图」用，每格独立） */
  viewStack: ViewSnapshot[] = [];
  suppressHistory = false;
  /** 最近一次设定的标准朝向（视口标签默认值） */
  dir: ViewDir = 'iso';

  constructor(aspect: number, position: THREE.Vector3, up: THREE.Vector3, mode: ProjectionMode = 'perspective') {
    this.mode = mode;
    this.persp = new THREE.PerspectiveCamera(38, aspect, 0.1, 20000);
    this.persp.position.copy(position);
    this.persp.up.copy(up);
    this.ortho = new THREE.OrthographicCamera(-100, 100, 100, -100, -5000, 20000);
    this.ortho.position.copy(position);
    this.ortho.up.copy(up);
  }

  get camera(): THREE.Camera {
    return this.mode === 'perspective' ? this.persp : this.ortho;
  }

  snapshot(): ViewSnapshot {
    return {
      position: this.camera.position.clone(),
      target: this.target.clone(),
      up: this.camera.up.clone(),
      zoom: this.persp.zoom,
    };
  }
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly root: THREE.Group;
  readonly helpers: THREE.Group;
  readonly gridGroup: THREE.Group;
  readonly planeGroup: THREE.Group;
  readonly controls: OrbitControls;

  /** 视口格（≥1 个；多视口布局时每格一套相机） */
  private cells: ViewCell[] = [];
  private activeIndex = 0;
  private layout: LayoutName = 'single';

  /** 激活格（所有旧 API 都作用于它：拾取/标准视图/缩放/剖面…） */
  get active(): ViewCell {
    return this.cells[this.activeIndex] ?? this.cells[0];
  }

  /** 当前激活格下标（多视口布局时有意义） */
  get activeCellIndex(): number {
    return this.activeIndex;
  }

  /** 视口格数量 */
  get cellCount(): number {
    return this.cells.length;
  }

  /** 当前布局 */
  get layoutName(): LayoutName {
    return this.layout;
  }

  /** 每个格子的矩形（CSS 像素，左上角原点）与朝向标签——覆盖层与拾取共用 */
  private cellRects: CellRect[] = [];

  /** 当前激活的相机（透视 / 正投影可切换） */
  get camera(): THREE.Camera {
    return this.active.camera;
  }
  /** 透视相机（缩放、视角计算用） */
  get persp(): THREE.PerspectiveCamera {
    return this.active.persp;
  }
  get projection(): ProjectionMode {
    return this.active.mode;
  }

  private container: HTMLElement;
  private needsRender = true;
  private rafId = 0;
  private running = false;
  private ro: ResizeObserver | null = null;

  /** 剖面视图：全局裁剪平面（null = 关闭） */
  private clipPlane: THREE.Plane | null = null;

  /** 视口覆盖层（多视口时的格子边框 + 左上角视图名标签） */
  private overlay: HTMLDivElement;
  private cellEls: HTMLDivElement[] = [];

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

    // 视口覆盖层：多视口布局时的格子边框 + 视图名标签
    this.overlay = document.createElement('div');
    this.overlay.className = 'vp-cells';
    this.overlay.style.display = 'none';
    container.appendChild(this.overlay);

    // 初始单格（等轴测默认视角），布局从 localStorage 恢复
    this.applyLayout(Viewport.readStoredLayout() ?? 'single', true);
    const c0 = this.active;

    this.controls = new OrbitControls(c0.camera, this.renderer.domElement);
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
    this.controls.target.copy(c0.target);
    this.controls.addEventListener('change', () => this.invalidate());
    this.controls.addEventListener('end', () => this.rememberView());

    // 多视口：指针悬停即切换激活格（SolidWorks 行为；拖动中不切换，避免视角跳变）
    this.renderer.domElement.addEventListener('pointermove', (e) => {
      if (this.cells.length < 2 || e.buttons !== 0) return;
      const base = this.renderer.domElement.getBoundingClientRect();
      const i = this.cellIndexAt(e.clientX - base.left, e.clientY - base.top);
      if (i >= 0) this.setActiveCell(i);
    });

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
  private hemiLight!: THREE.HemisphereLight;
  private keyLight!: THREE.DirectionalLight;
  private fillLight!: THREE.DirectionalLight;
  private rimLight!: THREE.DirectionalLight;
  /** 预过滤环境贴图（RealView 用；默认不挂到 scene，保持经典 CAD 外观） */
  private envTexture: THREE.Texture | null = null;
  private realView = false;

  private setupLights(): void {
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x8a93a0, 1.15);
    this.scene.add(this.hemiLight);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
    this.keyLight.position.set(180, -220, 320);
    this.scene.add(this.keyLight);

    this.fillLight = new THREE.DirectionalLight(0xdfe9f7, 0.85);
    this.fillLight.position.set(-260, 140, 160);
    this.scene.add(this.fillLight);

    this.rimLight = new THREE.DirectionalLight(0xffffff, 0.7);
    this.rimLight.position.set(60, 320, -240);
    this.scene.add(this.rimLight);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    // RealView：预过滤环境贴图（默认不启用，仅 heads-up「RealView」打开时挂上）
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.envTexture = env.texture;
    pmrem.dispose();
  }

  /** RealView 图形：给实体材质加环境反射（SolidWorks 同名显示效果）。
   *  只开关 scene.environment，不改光源——LineBasic/Basic 材质不受影响，网格/基准面保持原样。 */
  setRealView(on: boolean): void {
    this.realView = on;
    this.scene.environment = on ? this.envTexture : null;
    this.invalidate();
  }

  get realViewOn(): boolean {
    return this.realView;
  }

  /**
   * 光源预设（Heads-up「光源」下拉）。
   * 每项 = [半球光强, 主光(强度, 位置), 补光(强度, 位置), 轮廓光(强度, 位置)]。
   */
  setLightPreset(name: string): void {
    const p: LightPreset = LIGHT_PRESETS[name as LightPresetName] ?? LIGHT_PRESETS['默认'];
    this.hemiLight.intensity = p.hemi;
    this.keyLight.intensity = p.key[0];
    this.keyLight.position.set(...p.key[1]);
    this.fillLight.intensity = p.fill[0];
    this.fillLight.position.set(...p.fill[1]);
    this.rimLight.intensity = p.rim[0];
    this.rimLight.position.set(...p.rim[1]);
    this.invalidate();
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

  // ---------------- 视口布局 ----------------
  /** 读持久化布局（SolidWorks 按文档记忆视口布局） */
  private static readStoredLayout(): LayoutName | null {
    try {
      const v = localStorage.getItem('solid2.viewports.v1');
      if (v && LAYOUT_DEFS.some((d) => d.id === v)) return v as LayoutName;
    } catch {
      /* 隐私模式等：忽略 */
    }
    return null;
  }

  /**
   * 切换视口布局（SolidWorks：视图 → 显示 → 视口）。
   * 每格拿到一套独立相机（默认朝向 front/top/right/iso），视图历史互不影响。
   */
  setLayout(name: LayoutName): void {
    if (!this.applyLayout(name)) return;
    try {
      localStorage.setItem('solid2.viewports.v1', this.layout);
    } catch {
      /* 忽略 */
    }
  }

  /** 应用布局；返回是否有变化。initial=true 时（构造期）不做持久化 */
  applyLayout(name: LayoutName, initial = false): boolean {
    const def = LAYOUT_DEFS.find((d) => d.id === name) ?? LAYOUT_DEFS[0];
    if (this.layout === def.id && this.cells.length === def.dirs.length) return false;
    const prev = this.cells.length ? this.active : null;
    const dist = prev ? Math.max(prev.persp.position.distanceTo(prev.target), 120) : 200;
    const tgt = prev ? prev.target.clone() : new THREE.Vector3(0, 0, 0);
    const mode = prev ? prev.mode : 'perspective';

    this.layout = def.id;
    // 先用新格子数算矩形，再建格子：cellAspect() 读的就是这些矩形
    this.computeCellRects(def.dirs.length);
    this.cells = def.dirs.map((dir, i) => {
      const cell = new ViewCell(this.cellAspect(i), dirPosition(dir, tgt, dist), dirUp(dir), mode);
      cell.target.copy(tgt);
      cell.dir = dir;
      return cell;
    });
    // SolidWorks：多视口默认激活等轴测格（四视图右下角）；单视图保持当前视角
    this.activeIndex = def.dirs.length > 1 ? def.dirs.length - 1 : 0;
    this.bindControls();
    this.buildOverlay();
    this.renderOverlay();
    if (!initial) this.invalidate();
    return true;
  }

  /** 切换激活视口格（点击/悬停；SolidWorks 激活格带高亮边框） */
  setActiveCell(i: number): void {
    if (i === this.activeIndex || i < 0 || i >= this.cells.length) return;
    this.activeIndex = i;
    this.bindControls();
    this.syncOrthoFrustum();
    this.controls.update();
    this.renderOverlay();
    this.invalidate();
  }

  /** 各格的朝向标签（视口左上角显示；UI/测试用） */
  cellLabels(): string[] {
    return this.cells.map((c) => VIEW_NAMES[c.dir] ?? '等轴测');
  }

  /** 激活格是否高亮（测试用） */
  isActiveCell(i: number): boolean {
    return i === this.activeIndex;
  }

  private bindControls(): void {
    const controls = this.controls as OrbitControls | undefined;
    if (!controls) return;
    controls.object = this.active.camera;
    controls.target = this.active.target;
  }

  /** 按布局切分视口格（CSS 像素，左上角原点） */
  private computeCellRects(count?: number): void {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    const n = count ?? this.cells.length ?? 1;
    const gap = 3;
    const half = n === 2 ? (this.layout === 'twoH' ? w / 2 : h / 2) : 0;
    const rects: CellRect[] = [];
    if (n <= 1) {
      rects.push({ x: 0, y: 0, w, h });
    } else if (n === 2 && this.layout === 'twoH') {
      rects.push({ x: 0, y: 0, w: half - gap / 2, h });
      rects.push({ x: half + gap / 2, y: 0, w: w - half - gap / 2, h });
    } else if (n === 2 && this.layout === 'twoV') {
      rects.push({ x: 0, y: 0, w, h: half - gap / 2 });
      rects.push({ x: 0, y: half + gap / 2, w, h: h - half - gap / 2 });
    } else {
      const cw = w / 2;
      const ch = h / 2;
      rects.push({ x: 0, y: 0, w: cw - gap / 2, h: ch - gap / 2 });
      rects.push({ x: cw + gap / 2, y: 0, w: w - cw - gap / 2, h: ch - gap / 2 });
      rects.push({ x: 0, y: ch + gap / 2, w: cw - gap / 2, h: h - ch - gap / 2 });
      rects.push({ x: cw + gap / 2, y: ch + gap / 2, w: w - cw - gap / 2, h: h - ch - gap / 2 });
    }
    this.cellRects = rects;
  }

  private cellAspect(i: number): number {
    const r = this.cellRects[i];
    return r ? r.w / Math.max(r.h, 1) : this.aspect();
  }

  /** 激活格矩形（CSS 像素，左上角原点） */
  private activeRect(): CellRect {
    return (
      this.cellRects[this.activeIndex] ?? {
        x: 0,
        y: 0,
        w: this.container.clientWidth || 800,
        h: this.container.clientHeight || 600,
      }
    );
  }

  /** 屏幕（客户区）坐标落在哪个格；单格布局恒返回 0 */
  private cellIndexAt(x: number, y: number): number {
    if (this.cellRects.length <= 1) return 0;
    for (let i = 0; i < this.cellRects.length; i++) {
      const r = this.cellRects[i];
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return i;
    }
    return this.activeIndex;
  }

  // ---------------- 覆盖层（格子边框 + 视图名） ----------------
  private buildOverlay(): void {
    clear(this.overlay);
    this.cellEls = [];
    this.overlay.style.display = this.cells.length > 1 ? '' : 'none';
    for (let i = 0; i < this.cells.length; i++) {
      const cell = el('div', { class: 'vp-cell', dataset: { cell: String(i) } });
      cell.appendChild(el('span', { class: 'vp-cell-label', text: VIEW_NAMES[this.cells[i].dir] }));
      this.overlay.appendChild(cell);
      this.cellEls.push(cell);
    }
  }

  private renderOverlay(): void {
    if (this.cellEls.length !== this.cells.length) this.buildOverlay();
    if (this.cells.length <= 1) {
      this.overlay.style.display = 'none';
      return;
    }
    this.overlay.style.display = '';
    for (let i = 0; i < this.cells.length; i++) {
      const r = this.cellRects[i];
      const node = this.cellEls[i];
      if (!node) continue;
      // 激活高亮不依赖矩形（矩形缺失只是位置信息没算出来）
      node.classList.toggle('active', i === this.activeIndex);
      if (!r) continue;
      node.style.left = `${r.x}px`;
      node.style.top = `${r.y}px`;
      node.style.width = `${r.w}px`;
      node.style.height = `${r.h}px`;
      const label = node.firstElementChild as HTMLElement | null;
      if (label) label.textContent = this.cellLabels()[i] ?? '';
    }
  }

  // ---------------- 尺寸 ----------------
  private aspect(): number {
    const r = this.activeRect();
    return r.w / Math.max(r.h, 1);
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.computeCellRects();
    for (let i = 0; i < this.cells.length; i++) {
      const a = this.cellAspect(i);
      this.cells[i].persp.aspect = a;
      this.cells[i].persp.updateProjectionMatrix();
    }
    this.syncOrthoFrustum();
    this.renderOverlay();
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
        this.renderAll();
        this.needsRender = false;
      }
    };
    loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** 渲染全部视口格（单格 = 整幅；多格 = scissor 分格渲染同一场景） */
  private renderAll(): void {
    if (this.cells.length <= 1) {
      this.renderer.render(this.scene, this.active.camera);
      return;
    }
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setScissorTest(true);
    this.renderer.autoClear = false;
    this.renderer.clear();
    for (let i = 0; i < this.cells.length; i++) {
      const r = this.cellRects[i];
      if (!r) continue;
      const gy = h - r.y - r.h; // WebGL 视口原点在左下
      this.renderer.setViewport(r.x, gy, r.w, r.h);
      this.renderer.setScissor(r.x, gy, r.w, r.h);
      this.renderer.render(this.scene, this.cells[i].camera);
    }
    this.renderer.autoClear = true;
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.setScissor(0, 0, w, h);
  }

  dispose(): void {
    this.stop();
    this.ro?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
  }

  // ---------------- 显示模式 / 布景 / 剖面 ----------------
  /** 透视 / 正投影（SolidWorks「显示模式」，多视口时只作用于激活格） */
  setProjection(mode: ProjectionMode): void {
    const c = this.active;
    if (c.mode === mode) return;
    const pos = c.camera.position.clone();
    const up = c.camera.up.clone();
    c.mode = mode;
    const cam = c.camera;
    cam.position.copy(pos);
    cam.up.copy(up);
    if (mode === 'orthographic') this.syncOrthoFrustum();
    this.controls.object = cam;
    this.controls.update();
    this.invalidate();
  }

  /** 正投影视锥随当前相机距离与激活格视口尺寸自适应，观感与透视一致 */
  private syncOrthoFrustum(): void {
    const c = this.active;
    const dist = c.persp.position.distanceTo(this.controls.target) || 200;
    const h = 2 * Math.tan((c.persp.fov * Math.PI) / 360) * dist;
    const w = h * this.aspect();
    const cam = c.ortho;
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

  // ---------------- 视图历史（每格独立） ----------------
  /** 记录一次视图（相机停止运动后自动调用） */
  private rememberView(): void {
    const c = this.active;
    if (c.suppressHistory) return;
    const snap = c.snapshot();
    const last = c.viewStack[c.viewStack.length - 1];
    if (last && last.position.distanceToSquared(snap.position) < 1e-6 && last.target.distanceToSquared(snap.target) < 1e-6) {
      return;
    }
    c.viewStack.push(snap);
    if (c.viewStack.length > 30) c.viewStack.shift();
  }

  private snapshotView(): ViewSnapshot {
    return this.active.snapshot();
  }

  /** 相机快照（纯数据，可跨文档保存；多文档切换用） */
  cameraSnapshot(): { position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; zoom: number } {
    const s = this.snapshotView();
    return {
      position: [s.position.x, s.position.y, s.position.z],
      target: [s.target.x, s.target.y, s.target.z],
      up: [s.up.x, s.up.y, s.up.z],
      zoom: s.zoom,
    };
  }

  /** 恢复相机快照（null = 不动） */
  restoreCamera(s: { position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; zoom: number } | null): void {
    if (!s) return;
    const c = this.active;
    const p = new THREE.Vector3(...s.position);
    const t = new THREE.Vector3(...s.target);
    const u = new THREE.Vector3(...s.up);
    c.persp.position.copy(p);
    c.ortho.position.copy(p);
    this.controls.target.copy(t);
    c.target.copy(t);
    c.persp.up.copy(u);
    c.ortho.up.copy(u);
    c.persp.zoom = s.zoom;
    c.ortho.zoom = s.zoom;
    c.persp.updateProjectionMatrix();
    c.ortho.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  get hasPrevView(): boolean {
    return this.active.viewStack.length > 1;
  }

  /** 上一视图（SolidWorks 视图工具栏，只回退当前激活格） */
  prevView(): boolean {
    const c = this.active;
    if (c.viewStack.length < 2) return false;
    c.viewStack.pop(); // 当前视图
    const v = c.viewStack[c.viewStack.length - 1];
    c.suppressHistory = true;
    c.persp.position.copy(v.position);
    c.ortho.position.copy(v.position);
    this.controls.target.copy(v.target);
    c.target.copy(v.target);
    c.persp.up.copy(v.up);
    c.ortho.up.copy(v.up);
    c.persp.zoom = v.zoom;
    c.persp.updateProjectionMatrix();
    this.syncOrthoFrustum();
    this.controls.update();
    c.suppressHistory = false;
    this.invalidate();
    return true;
  }

  // ---------------- 视图朝向 ----------------
  setView(dir: ViewDir, animate = true): void {
    const c = this.active;
    c.dir = dir;
    const dist = c.camera.position.distanceTo(this.controls.target) || 200;
    const target = this.controls.target.clone();
    const d = new THREE.Vector3(...(VIEW_DIRS[dir]?.dir ?? VIEW_DIRS.iso.dir)).normalize();
    const pos = target.clone().addScaledVector(d, dist);
    const up = new THREE.Vector3(...(VIEW_DIRS[dir]?.up ?? VIEW_DIRS.iso.up));

    if (!animate) {
      c.persp.up.copy(up);
      c.persp.position.copy(pos);
      c.ortho.up.copy(up);
      c.ortho.position.copy(pos);
      this.controls.target.copy(target);
      c.target.copy(target);
      this.syncOrthoFrustum();
      this.controls.update();
      this.rememberView();
      this.renderOverlay();
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
    const c = this.active;
    const from = c.camera.position.clone();
    const fromUp = c.camera.up.clone();
    const fromTarget = this.controls.target.clone();
    const t0 = performance.now();
    const dur = 300;
    const step = () => {
      if (token !== this.animToken) return;
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
      const p = new THREE.Vector3().lerpVectors(from, pos, e);
      c.persp.position.copy(p);
      c.ortho.position.copy(p);
      this.controls.target.lerpVectors(fromTarget, target, e);
      c.target.copy(this.controls.target);
      const u = fromUp.clone().lerp(up, e).normalize();
      c.persp.up.copy(u);
      c.ortho.up.copy(u);
      c.camera.lookAt(this.controls.target);
      this.invalidate();
      if (t < 1) requestAnimationFrame(step);
      else {
        this.rememberView();
        this.renderOverlay();
      }
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
    const fov = (this.persp.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.35;

    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, -1, 0.85);
    dir.normalize();
    const pos = center.clone().addScaledVector(dir, dist);
    this.animateCamera(pos, center, this.camera.up.clone());
  }

  /** 按系数缩放（>1 拉近，<1 推远） */
  zoomBy(factor: number): void {
    const c = this.active;
    const offset = c.camera.position.clone().sub(this.controls.target);
    const dist = offset.length();
    const next = THREE.MathUtils.clamp(dist / factor, this.controls.minDistance, this.controls.maxDistance);
    const pos = this.controls.target.clone().addScaledVector(offset.normalize(), next);
    c.persp.position.copy(pos);
    c.ortho.position.copy(pos);
    this.syncOrthoFrustum();
    this.controls.update();
    this.rememberView();
    this.invalidate();
  }

  /** 缩放至区域：把屏幕矩形框内的内容放大铺满（当前激活格）视口 */
  zoomArea(rect: { x: number; y: number; w: number; h: number }): void {
    const r = this.activeRect();
    const W = r.w || 1;
    const H = r.h || 1;
    if (rect.w < 6 || rect.h < 6) return;

    const viewDir = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewDir, this.controls.target);
    const rc = new THREE.Raycaster();

    // rect 是画布相对坐标；多视口时换算成激活格内的 NDC 再射线
    const corner = (sx: number, sy: number): THREE.Vector3 | null => {
      const ndc = new THREE.Vector2(
        ((rect.x + sx - r.x) / Math.max(W, 1)) * 2 - 1,
        -((rect.y + sy - r.y) / Math.max(H, 1)) * 2 + 1
      );
      rc.setFromCamera(ndc, this.camera);
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
    const fov = (this.persp.fov * Math.PI) / 180;
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
    const c = this.active;
    c.persp.position.copy(pos);
    c.ortho.position.copy(pos);
    c.camera.lookAt(this.controls.target);
    this.syncOrthoFrustum();
    this.controls.update();
    this.rememberView();
    this.invalidate();
  }

  /** 平移视图（Ctrl+方向键用），比例 = 屏幕宽度的 10% */
  panView(dxScreenFrac: number, dyScreenFrac: number): void {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const h = 2 * Math.tan((this.persp.fov * Math.PI) / 360) * dist;
    const w = h * this.aspect();
    const viewDir = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).normalize();
    const right = new THREE.Vector3().crossVectors(viewDir, this.camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, viewDir).normalize();
    const delta = new THREE.Vector3()
      .addScaledVector(right, -dxScreenFrac * w)
      .addScaledVector(up, dyScreenFrac * h);
    this.controls.target.add(delta);
    const c = this.active;
    c.target.copy(this.controls.target);
    c.persp.position.add(delta);
    c.ortho.position.add(delta);
    this.controls.update();
    this.rememberView();
    this.invalidate();
  }

  /** 屏幕（客户区）坐标 → 世界射线（按激活格矩形换算 NDC，多视口拾取才正确） */
  rayFromScreen(x: number, y: number): THREE.Raycaster {
    const base = this.renderer.domElement.getBoundingClientRect();
    const r = this.activeRect();
    const ndc = new THREE.Vector2(
      ((x - base.left - r.x) / Math.max(r.w, 1)) * 2 - 1,
      -((y - base.top - r.y) / Math.max(r.h, 1)) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.active.camera);
    return rc;
  }

  /** 世界坐标 → 画布像素（覆盖层/标注定位用；多视口时位于激活格内） */
  worldToScreen(p: [number, number, number]): { x: number; y: number } {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(this.active.camera);
    const r = this.activeRect();
    return {
      x: r.x + ((v.x + 1) / 2) * r.w,
      y: r.y + ((-v.y + 1) / 2) * r.h,
    };
  }

  /** 相机到目标点的距离 */
  get cameraDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /** 一个像素对应多少世界单位（用于拾取容差） */
  pixelSizeAt(p: [number, number, number]): number {
    const dist = this.camera.position.distanceTo(new THREE.Vector3(p[0], p[1], p[2]));
    const h = 2 * Math.tan((this.persp.fov * Math.PI) / 360) * dist;
    return h / Math.max(this.activeRect().h, 1);
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

  /** 截图（data URL，多视口时整幅画布） */
  snapshot(): string {
    this.renderAll();
    return this.renderer.domElement.toDataURL('image/png');
  }
}

/** 标准朝向 → 相机位置（target + 方向 × 距离） */
function dirPosition(dir: ViewDir, target: THREE.Vector3, dist: number): THREE.Vector3 {
  const d = new THREE.Vector3(...(VIEW_DIRS[dir]?.dir ?? VIEW_DIRS.iso.dir)).normalize();
  return target.clone().addScaledVector(d, dist);
}

/** 标准朝向 → 上方向 */
function dirUp(dir: ViewDir): THREE.Vector3 {
  return new THREE.Vector3(...(VIEW_DIRS[dir]?.up ?? VIEW_DIRS.iso.up));
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
