/**
 * 拾取交互服务单测（纯编排 + three.js 数学，不依赖 DOM / 视口 / 内核 Worker / OCCT）。
 *
 * 覆盖 `src/app/pick-service.ts` 的核心路径：
 *   - handleClick 分发：onCanvasClick 钩子 → 装配态 / 模型态（顶点过滤器 / 实体过滤器 /
 *     棱边优先 / 射线穿面 / 草图显示层兜底）→ 工程图态直接返回
 *   - pickVertex 就近原则（真实相机投影 + 网格）
 *   - pickCandidateFaces 去重 / 反查 -1 / 无视图
 *   - bodyIndexOfFace 宿主透传
 *   - 装配拾取：棱边优先（圆边=轴）→ 圆柱面轴 → 平面；未命中清空；累积到 2 个后重置；
 *     3D 标记重建与显隐
 *   - bindPointer：点击 vs 拖拽分流（4px / 左键 / shift）、草图拖拽收尾、
 *     pointerleave 喂越界坐标、dblclick 仅草图态结束 B 样条
 *   - sketchPickTol 折算（经 selectSketchAt 观察 pickDisplay 收到的世界容差）
 */
import * as THREE from 'three';
import { PickService, type PickHost } from '../src/app/pick-service';
import type { MateRef, Assembly, Component } from '../src/app/assembly';
import type { SketchFeature } from '../src/doc/types';
import type { ShapeView } from '../src/view/shapeview';
import type { FaceMeta, EdgeMeta, MeshResult } from '../src/core/kernel-types';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}

// ---- 假 ShapeView（只实现拾取路径用到的成员）----
function fakeShapeView(opts: {
  vertices?: number[];
  faces?: Partial<FaceMeta>[];
  edges?: Partial<EdgeMeta>[];
  edgePolylines?: number[][];
  faceFromTri?: (t: number) => number;
}): ShapeView {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(opts.vertices ?? [0, 0, 0], 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  return {
    mesh,
    faceIndexFromTriangle: opts.faceFromTri ?? (() => 0),
    faceMetas: (opts.faces ?? []) as FaceMeta[],
    edgeMetas: (opts.edges ?? []) as EdgeMeta[],
    meshResult: { edgePolylines: opts.edgePolylines ?? [] } as unknown as MeshResult,
  } as unknown as ShapeView;
}

/** 假射线：intersectObject 无视对象、恒返回配置的命中 */
function fakeRay(hits: { faceIndex?: number; distance?: number }[]): THREE.Raycaster {
  return {
    intersectObject: () => hits.map((h) => ({ faceIndex: h.faceIndex, distance: h.distance ?? 1 })),
  } as unknown as THREE.Raycaster;
}

/** 假装配体：组件表 + getComponent + 单位矩阵 */
function fakeAssembly(comps: (Component & { name?: string })[]): Assembly {
  return {
    components: comps,
    getComponent: (id: string) => comps.find((c) => c.id === id) ?? null,
    displayMatrix: () => new THREE.Matrix4(),
  } as unknown as Assembly;
}

function makeHost(overrides: Partial<PickHost> = {}) {
  const rec = {
    applies: [] as { kind: string; index: number; additive: boolean }[],
    clears: 0,
    refreshes: 0,
    syncDisp: 0,
    selectFeatures: [] as (string | null)[],
    statuses: [] as { text: string; kind: string; detail?: string }[],
    emits: [] as string[][],
    invalidates: 0,
    hookCalls: [] as { x: number; y: number; additive: boolean }[],
    sketchCalls: { down: [] as [number, number][], move: [] as [number, number][], up: 0, bSpline: 0 },
    pickDisplay: [] as { tol: number; hit: SketchFeature | null }[],
  };
  let mode: 'model' | 'sketch' | 'assembly' | 'drawing' = 'model';
  let filter: 'all' | 'face' | 'edge' | 'vertex' | 'body' = 'all';
  let sv: ShapeView | null = null;
  let asm: Assembly | null = null;
  let downResult = false;
  let sketchMode = false;
  let displayPlane: { origin: [number, number, number] } | null = null;
  let displayHit: SketchFeature | null = null;
  let faceBodyIndex = (_fi: number) => -1;
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  let ray: THREE.Raycaster = fakeRay([]);
  const root = new THREE.Group();
  const host: PickHost = {
    shapeView: () => sv,
    rayFromScreen: () => ray,
    worldToScreen: (p) => ({ x: p[0] * 10, y: p[1] * 10 }),
    canvasRect: () => ({ left: 0, top: 0, width: 100, height: 100, clientHeight: 800 }),
    camera: () => cam,
    sceneRoot: () => root,
    invalidate: () => { rec.invalidates++; },
    assembly: () => asm,
    mode: () => mode,
    selectionFilter: () => filter,
    faceBodyIndex: (fi) => faceBodyIndex(fi),
    mateRefLabel: (r) => `L(${r.kind})`,
    applyGeomSelection: (kind, index, additive) => { rec.applies.push({ kind, index, additive }); },
    clearSelection: () => { rec.clears++; },
    refreshHighlight: () => { rec.refreshes++; },
    syncSketchDisplaySelection: () => { rec.syncDisp++; },
    selectFeature: (id) => { rec.selectFeatures.push(id); },
    setStatus: (text, kind, detail) => { rec.statuses.push({ text, kind, detail }); },
    emit: (...evts) => { rec.emits.push(evts as string[]); },
    sketchDisplayPlane: () => displayPlane,
    sketchPickDisplay: (r, tol) => { rec.pickDisplay.push({ tol, hit: displayHit }); return displayHit; },
    sketchHandleDown: (x, y) => { rec.sketchCalls.down.push([x, y]); return downResult; },
    sketchHandleMove: (x, y) => { rec.sketchCalls.move.push([x, y]); },
    sketchHandleUp: () => { rec.sketchCalls.up++; },
    sketchFinishBSpline: () => { rec.sketchCalls.bSpline++; },
    isSketchMode: () => sketchMode,
    onCanvasClickHook: (x, y, additive) => { rec.hookCalls.push({ x, y, additive }); return false; },
    ...overrides,
  };
  const svc = new PickService(host);
  const api = {
    svc, rec, root,
    set: (o: { mode?: typeof mode; filter?: typeof filter; sv?: ShapeView | null; asm?: Assembly | null; downResult?: boolean; sketchMode?: boolean; displayPlane?: typeof displayPlane; displayHit?: SketchFeature | null; faceBodyIndex?: typeof faceBodyIndex; ray?: THREE.Raycaster; camZ?: number }) => {
      if (o.mode !== undefined) mode = o.mode;
      if (o.filter !== undefined) filter = o.filter;
      if (o.sv !== undefined) sv = o.sv;
      if (o.asm !== undefined) asm = o.asm;
      if (o.downResult !== undefined) downResult = o.downResult;
      if (o.sketchMode !== undefined) sketchMode = o.sketchMode;
      if (o.displayPlane !== undefined) displayPlane = o.displayPlane;
      if (o.displayHit !== undefined) displayHit = o.displayHit;
      if (o.faceBodyIndex !== undefined) faceBodyIndex = o.faceBodyIndex;
      if (o.ray !== undefined) ray = o.ray;
      if (o.camZ !== undefined) { cam.position.set(0, 0, o.camZ); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(); }
    },
  };
  return api;
}

// ---- handleClick：外部钩子优先消费 ----
{
  const h = makeHost({ onCanvasClickHook: (x, y, additive) => { h.rec.hookCalls.push({ x, y, additive }); return true; } });
  h.svc.handleClick(10, 20, true);
  check('handleClick：onCanvasClick 返回 true 即消费，不再分发',
    h.rec.hookCalls.length === 1 && h.rec.applies.length === 0 && h.rec.clears === 0);
}

// ---- handleClick：工程图态直接返回 ----
{
  const h = makeHost();
  h.set({ mode: 'drawing' });
  h.svc.handleClick(10, 10, false);
  check('handleClick：drawing 态先过钩子、随后直接返回（无选择副作用）',
    h.rec.hookCalls.length === 1 && h.rec.clears === 0 && h.rec.applies.length === 0 &&
    h.rec.pickDisplay.length === 0);
}

// ---- handleClick：模型态无视图 → 草图显示层兜底 ----
{
  const h = makeHost();
  h.set({ sv: null, displayPlane: null });
  h.svc.handleClick(10, 10, false);
  check('handleClick：无 shapeView → 草图显示层兜底；无显示草图 → clearSelection',
    h.rec.clears === 1 && h.rec.pickDisplay.length === 0);
}
{
  const h = makeHost();
  h.set({ sv: null, displayPlane: { origin: [0, 0, 0] }, displayHit: { id: 'sk1', name: '草图1' } as SketchFeature });
  h.svc.handleClick(10, 10, false);
  check('handleClick：命中显示草图 → selectFeature + 状态「已选择草图」',
    h.rec.selectFeatures.length === 1 && h.rec.selectFeatures[0] === 'sk1' &&
    h.rec.statuses[0].text === '已选择草图' && h.rec.statuses[0].detail === '草图1');
  check('handleClick：sketchPickTol 折算正确（camZ=10, h=800, fov=50 → max(0.0699,0.4)=0.4）',
    h.rec.pickDisplay.length === 1 && Math.abs(h.rec.pickDisplay[0].tol - 0.4) < 1e-9,
    String(h.rec.pickDisplay[0]?.tol));
}
{
  const h = makeHost();
  h.set({ sv: null, displayPlane: { origin: [0, 0, 0] }, displayHit: null, camZ: 100 });
  h.svc.handleClick(10, 10, false);
  // dist=100 → worldPerPx = 2*100*tan(25°)/800 = 0.116576 → tol = 0.699459
  check('handleClick：sketchPickTol 未触底（camZ=100 → 0.6995）',
    h.rec.pickDisplay.length === 1 && Math.abs(h.rec.pickDisplay[0].tol - 0.6994586) < 1e-5,
    String(h.rec.pickDisplay[0]?.tol));
}

// ---- pickVertex（真实相机投影 + 网格）----
{
  const sv = fakeShapeView({ vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0] });
  const h = makeHost();
  h.set({ sv });
  check('pickVertex：点击屏幕中心命中原点顶点（相机 (0,0,10) 正视，画布 100×100）',
    h.svc.pickVertex(50, 50) === 0);
  check('pickVertex：8px 外无顶点 → null', h.svc.pickVertex(90, 90) === null);
  h.set({ sv: null });
  check('pickVertex：无 shapeView → null', h.svc.pickVertex(50, 50) === null);
  const noAttr = { mesh: new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()) } as unknown as ShapeView;
  h.set({ sv: noAttr });
  check('pickVertex：网格无 position 属性 → null', h.svc.pickVertex(50, 50) === null);
}

// ---- handleClick：顶点过滤器 ----
{
  const sv = fakeShapeView({ vertices: [0, 0, 0, 1, 0, 0] });
  const h = makeHost();
  h.set({ sv, filter: 'vertex' });
  h.svc.handleClick(50, 50, true);
  check('handleClick 顶点过滤器：命中 → applyGeomSelection(vertex, 0, additive) + 状态',
    h.rec.applies.length === 1 && h.rec.applies[0].kind === 'vertex' && h.rec.applies[0].index === 0 &&
    h.rec.applies[0].additive === true && h.rec.statuses[0].text === '已选择顶点');
  h.svc.handleClick(90, 90, false);
  check('handleClick 顶点过滤器：未命中 → clearSelection', h.rec.clears === 1);
}

// ---- handleClick：实体过滤器 ----
{
  const sv = fakeShapeView({ faceFromTri: (t) => t, faces: [{ area: 1 }] });
  const h = makeHost();
  h.set({ sv, filter: 'body', faceBodyIndex: (fi) => (fi === 0 ? 2 : -1), ray: fakeRay([{ faceIndex: 0, distance: 3 }]) });
  h.svc.handleClick(50, 50, false);
  check('handleClick 实体过滤器：命中面 → 反查 bodyIndex → applyGeomSelection(body, 2) + 状态「实体 3」',
    h.rec.applies.length === 1 && h.rec.applies[0].kind === 'body' && h.rec.applies[0].index === 2 &&
    h.rec.statuses[0].text === '已选择实体' && h.rec.statuses[0].detail === '实体 3');
  h.set({ faceBodyIndex: () => -1 });
  h.svc.handleClick(50, 50, false);
  check('handleClick 实体过滤器：bodyIndex=-1 → clearSelection', h.rec.clears === 1);
}

// ---- handleClick：棱边优先（屏幕空间），然后射线穿面 ----
{
  // worldToScreen 映射 p → (10x, 10y)；点击 (100,100) → 折线 (9,10,0)→(11,10,0) 距离 0
  const sv = fakeShapeView({
    edgePolylines: [[9, 10, 0, 11, 10, 0]],
    edges: [{ length: 12.5, curveType: 'line', mid: [10, 10, 0], dir: [1, 0, 0] } as Partial<EdgeMeta>],
  });
  const h = makeHost();
  h.set({ sv, ray: fakeRay([{ faceIndex: 0, distance: 1 }]) });
  h.svc.handleClick(100, 100, false);
  check('handleClick：棱边优先于面（屏幕空间距离 0）→ applyGeomSelection(edge, 0) + 长度状态',
    h.rec.applies.length === 1 && h.rec.applies[0].kind === 'edge' && h.rec.applies[0].index === 0 &&
    h.rec.statuses[0].text === '已选择边' && h.rec.statuses[0].detail === '长度 12.50 mm');
}
{
  const sv = fakeShapeView({
    edgePolylines: [],
    // faceFromTri: t → t+4，故 faceMetas 需覆盖到下标 4
    faces: [{ area: 1 }, { area: 1 }, { area: 1 }, { area: 1 }, { area: 24 } as Partial<FaceMeta>],
    faceFromTri: (t) => t + 4,
  });
  const h = makeHost();
  h.set({ sv, ray: fakeRay([{ faceIndex: 0, distance: 1 }]) });
  h.svc.handleClick(100, 100, true);
  check('handleClick：无近处棱边 → 射线穿面 → applyGeomSelection(face, 4, additive) + 面积状态',
    h.rec.applies.length === 1 && h.rec.applies[0].kind === 'face' && h.rec.applies[0].index === 4 &&
    h.rec.applies[0].additive === true && h.rec.statuses[0].text === '已选择面' &&
    h.rec.statuses[0].detail === '面积 24.00 mm²');
}
{
  const sv = fakeShapeView({ edgePolylines: [], faces: [] });
  const h = makeHost();
  h.set({ sv, ray: fakeRay([]), displayPlane: null });
  h.svc.handleClick(100, 100, false);
  check('handleClick：面也落空 → 草图显示层兜底（无显示草图 → clearSelection）', h.rec.clears === 1);
}

// ---- pickCandidateFaces ----
{
  const sv = fakeShapeView({ faceFromTri: (t) => (t === 4 ? -1 : t === 1 ? 0 : t) });
  const h = makeHost();
  h.set({ sv, ray: fakeRay([{ faceIndex: 0 }, { faceIndex: 1 }, { faceIndex: 4 }]) });
  const cands = h.svc.pickCandidateFaces(50, 50);
  check('pickCandidateFaces：三角形→面 去重、-1 剔除（0,1→0；4→-1）',
    cands.length === 1 && cands[0] === 0, JSON.stringify(cands));
  h.set({ sv: null });
  check('pickCandidateFaces：无 shapeView → []', h.svc.pickCandidateFaces(50, 50).length === 0);
}

// ---- bodyIndexOfFace ----
{
  const h = makeHost({ faceBodyIndex: () => 3 });
  check('bodyIndexOfFace：宿主透传（3）', h.svc.bodyIndexOfFace(7) === 3);
  const h2 = makeHost();
  check('bodyIndexOfFace：宿主返回 -1 原样透传', h2.svc.bodyIndexOfFace(0) === -1);
}

// ---- 装配拾取：圆柱面轴参考 ----
{
  const view = fakeShapeView({
    faceFromTri: (t) => t,
    faces: [{ surfaceType: 'cylinder', axis: { point: [1, 2, 3], dir: [0, 1, 0] }, radius: 4, centroid: [0, 0, 0], normal: [0, 1, 0] } as Partial<FaceMeta>],
  });
  const asm = fakeAssembly([{ id: 'c1', visible: true, view, name: '零件1' } as unknown as Component]);
  const h = makeHost();
  h.set({ mode: 'assembly', asm, ray: fakeRay([{ faceIndex: 0, distance: 5 }]) });
  h.svc.handleClick(100, 100, false);
  const ref = h.svc.picks[0];
  check('装配拾取：圆柱面 → 轴参考（cylindrical / isAxis / 半径 / 局部点向）',
    h.svc.picks.length === 1 && ref?.kind === 'cylindrical' && ref?.isAxis === true && ref?.radius === 4 &&
    JSON.stringify(ref?.localPoint) === '[1,2,3]' && JSON.stringify(ref?.localDir) === '[0,1,0]' && ref?.comp === 'c1',
    JSON.stringify(ref));
  check('装配拾取：状态含标签 + 宿主 mateRefLabel + emit(change,props) + invalidate',
    h.rec.statuses[0].text === '装配拾取' && h.rec.statuses[0].detail === '圆柱面（轴）（1/2）：零件1·L(cylindrical)' &&
    h.rec.emits.some((e) => e.includes('change') && e.includes('props')) && h.rec.invalidates === 1,
    JSON.stringify(h.rec.statuses[0]));
}

// ---- 装配拾取：圆边优先于面（7px 阈值）----
{
  const view = fakeShapeView({
    edgePolylines: [[9, 10, 0, 11, 10, 0]],
    edges: [{ curveType: 'circle', axis: { point: [1, 2, 3], dir: [0, 0, 1] }, radius: 5, mid: [10, 10, 0], dir: [1, 0, 0] } as Partial<EdgeMeta>],
    faceFromTri: (t) => t,
    faces: [{ surfaceType: 'plane', centroid: [1, 1, 1], normal: [0, 1, 0] } as Partial<FaceMeta>],
  });
  const asm = fakeAssembly([{ id: 'c1', visible: true, view, name: '零件1' } as unknown as Component]);
  const h = makeHost();
  h.set({ mode: 'assembly', asm, ray: fakeRay([{ faceIndex: 0, distance: 5 }]) });
  h.svc.handleClick(100, 100, false);
  const ref = h.svc.picks[0];
  check('装配拾取：圆边优先 → 轴参考（label 圆边（轴），半径 5）',
    h.svc.picks.length === 1 && ref?.kind === 'cylindrical' && ref?.radius === 5 &&
    h.rec.statuses[0].detail === '圆边（轴）（1/2）：零件1·L(cylindrical)',
    JSON.stringify(h.rec.statuses[0]));
}

// ---- 装配拾取：平面面 ----
{
  const view = fakeShapeView({
    faceFromTri: (t) => t,
    faces: [{ surfaceType: 'plane', centroid: [1, 1, 1], normal: [0, 1, 0] } as Partial<FaceMeta>],
  });
  const asm = fakeAssembly([{ id: 'c1', visible: true, view, name: '零件1' } as unknown as Component]);
  const h = makeHost();
  h.set({ mode: 'assembly', asm, ray: fakeRay([{ faceIndex: 0, distance: 5 }]) });
  h.svc.handleClick(100, 100, false);
  const ref = h.svc.picks[0];
  check('装配拾取：平面面 → 平面参考（质心 + 法向，label 平面）',
    h.svc.picks.length === 1 && ref?.kind === 'planar' && !ref?.isAxis &&
    JSON.stringify(ref?.localPoint) === '[1,1,1]' && JSON.stringify(ref?.localDir) === '[0,1,0]' &&
    h.rec.statuses[0].detail === '平面（1/2）：零件1·L(planar)',
    JSON.stringify(ref));
}

// ---- 装配拾取：未命中清空 / 累积到 2 重置 / 显式 clearAssemblyPicks ----
{
  const view = fakeShapeView({ faceFromTri: (t) => t, faces: [{ surfaceType: 'plane', centroid: [0, 0, 0], normal: [0, 1, 0] } as Partial<FaceMeta>] });
  const asm = fakeAssembly([{ id: 'c1', visible: true, view, name: '零件1' } as unknown as Component]);
  const h = makeHost();
  h.set({ mode: 'assembly', asm, ray: fakeRay([{ faceIndex: 0, distance: 5 }]) });
  h.svc.handleClick(100, 100, false);
  h.svc.handleClick(100, 100, true); // additive → 第 2 个
  check('装配拾取：两次 additive → picks 累积到 2', h.svc.picks.length === 2);
  h.svc.handleClick(100, 100, false); // 第 3 个 → 重置
  check('装配拾取：第 3 次拾取重置为 1 个', h.svc.picks.length === 1);
  // 未命中任何组件
  h.set({ asm: fakeAssembly([]) });
  h.svc.handleClick(100, 100, false);
  check('装配拾取：未命中组件 → clearAssemblyPicks', h.svc.picks.length === 0);
  h.set({ asm });
  h.svc.handleClick(100, 100, false);
  h.svc.clearAssemblyPicks();
  check('clearAssemblyPicks：置空 + emit(change,props)', h.svc.picks.length === 0 && h.rec.emits.length > 0);
}

// ---- 装配拾取：3D 标记 ----
{
  const view = fakeShapeView({ faceFromTri: (t) => t, faces: [{ surfaceType: 'plane', centroid: [0, 0, 0], normal: [0, 1, 0] } as Partial<FaceMeta>] });
  const asm = fakeAssembly([{ id: 'c1', visible: true, view, name: '零件1' } as unknown as Component]);
  const h = makeHost();
  h.set({ mode: 'assembly', asm, ray: fakeRay([{ faceIndex: 0, distance: 5 }]) });
  h.svc.handleClick(100, 100, false);
  h.svc.handleClick(100, 100, true);
  // pickGroup 惰性创建并挂 sceneRoot；每个拾取一个标记节点（球 + 线段）
  check('3D 标记：惰性挂到 sceneRoot，2 个拾取 → 2 个标记节点',
    h.root.children.length === 1 && (h.root.children[0] as THREE.Group).children.length === 2);
  const g = h.root.children[0] as THREE.Group;
  check('3D 标记：装配态下可见 + userData.pickMarker',
    g.visible === true && g.userData.pickMarker === true);
  h.svc.setPickGroupVisible(false);
  check('setPickGroupVisible(false)：标记组隐藏', g.visible === false);
  h.svc.clearAssemblyPicks();
  check('clearAssemblyPicks：标记节点全部移除', g.children.length === 0);
  // assignPicks（setMode 的「置空」路径）：不带 emit
  const before = h.rec.emits.length;
  h.svc.assignPicks([]);
  check('assignPicks：整体替换、不带 emit（setMode/selectAll 语义）',
    h.svc.picks.length === 0 && h.rec.emits.length === before);
  h.svc.assignPicks([{ comp: 'c1', localPoint: [0, 0, 0], localDir: [0, 0, 1], kind: 'planar' } as MateRef]);
  check('assignPicks：置一后 picks 可读（selectAll 语义）',
    h.svc.picks.length === 1 && h.svc.picks[0].comp === 'c1');
}

// ---- bindPointer：点击 vs 拖拽分流 ----
function fakeCanvas() {
  const handlers = new Map<string, ((e: unknown) => void)[]>();
  const el = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      const arr = handlers.get(type) ?? [];
      arr.push(fn);
      handlers.set(type, arr);
    },
  } as unknown as HTMLElement;
  return {
    el,
    fire: (type: string, e: unknown) => { for (const fn of handlers.get(type) ?? []) fn(e); },
  };
}

{
  const h = makeHost();
  h.set({ sv: null, displayPlane: null }); // 点击可观察副作用：clearSelection
  const c = fakeCanvas();
  h.svc.bindPointer(c.el);
  c.fire('pointerdown', { clientX: 10, clientY: 10, button: 0 });
  c.fire('pointerup', { clientX: 12, clientY: 12, button: 0, shiftKey: true, ctrlKey: false });
  check('bindPointer：位移 2.8px ≤ 4 且左键 → 点击分发（shift → additive）',
    h.rec.hookCalls.length === 1 && h.rec.hookCalls[0].x === 12 && h.rec.hookCalls[0].additive === true &&
    h.rec.clears === 1);
}
{
  const h = makeHost();
  const c = fakeCanvas();
  h.svc.bindPointer(c.el);
  c.fire('pointerdown', { clientX: 10, clientY: 10, button: 0 });
  c.fire('pointerup', { clientX: 20, clientY: 20, button: 0, shiftKey: false, ctrlKey: false });
  check('bindPointer：位移 > 4px → 视为拖拽，不点击', h.rec.hookCalls.length === 0);
}
{
  const h = makeHost();
  const c = fakeCanvas();
  h.svc.bindPointer(c.el);
  c.fire('pointerdown', { clientX: 10, clientY: 10, button: 2 });
  c.fire('pointerup', { clientX: 10, clientY: 10, button: 2, shiftKey: false, ctrlKey: false });
  check('bindPointer：非左键不点击', h.rec.hookCalls.length === 0);
}
{
  const h = makeHost();
  const c = fakeCanvas();
  h.svc.bindPointer(c.el);
  c.fire('pointerup', { clientX: 10, clientY: 10, button: 0, shiftKey: false, ctrlKey: false });
  check('bindPointer：无 pointerdown 的 pointerup → 不点击', h.rec.hookCalls.length === 0);
}
{
  const h = makeHost();
  h.set({ downResult: true }); // 草图拖拽中
  const c = fakeCanvas();
  h.svc.bindPointer(c.el);
  c.fire('pointerdown', { clientX: 10, clientY: 10, button: 0 });
  check('bindPointer：pointerdown 左键 → sketchHandleDown 记录坐标',
    h.rec.sketchCalls.down.length === 1 && h.rec.sketchCalls.down[0][0] === 10 && h.rec.sketchCalls.down[0][1] === 10);
  c.fire('pointermove', { clientX: 15, clientY: 16 });
  check('bindPointer：pointermove → sketchHandleMove 转发', h.rec.sketchCalls.move.length === 1 && h.rec.sketchCalls.move[0][1] === 16);
  c.fire('pointerup', { clientX: 10, clientY: 10, button: 0, shiftKey: false, ctrlKey: false });
  check('bindPointer：草图拖拽中 pointerup → handleUp 收尾、不走点击分发',
    h.rec.sketchCalls.up === 1 && h.rec.hookCalls.length === 0);
}
{
  const h = makeHost();
  const c = fakeCanvas();
  h.svc.bindPointer(c.el);
  c.fire('pointerleave', {});
  check('bindPointer：pointerleave → sketchHandleMove(-1e6,-1e6)',
    h.rec.sketchCalls.move.length === 1 && h.rec.sketchCalls.move[0][0] === -1e6 && h.rec.sketchCalls.move[0][1] === -1e6);
}
{
  const h = makeHost();
  const c = fakeCanvas();
  h.svc.bindPointer(c.el);
  h.set({ sketchMode: true });
  c.fire('dblclick', {});
  check('bindPointer：dblclick 草图态 → finishBSpline', h.rec.sketchCalls.bSpline === 1);
}
{
  const h = makeHost();
  const c = fakeCanvas();
  h.svc.bindPointer(c.el);
  h.set({ sketchMode: false });
  c.fire('dblclick', {});
  check('bindPointer：dblclick 模型态 → 不结束 B 样条', h.rec.sketchCalls.bSpline === 0);
}

console.log(`\n拾取交互服务：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
if (fail > 0) process.exit(1);
