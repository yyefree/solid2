/**
 * 装配体模块。
 *
 * 配合（Mate）采用"局部几何捕获"方案：创建配合时把选中的面/边的几何
 * （点 + 法向/轴线）换算到**组件自身坐标系**存下来。组件是刚体，局部几何恒定，
 * 于是求解时只需把它用组件当前世界矩阵变换出去即可 —— 无需每次重新做拓扑查找。
 *
 * 求解用 Gauss-Seidel 迭代（纯 three.js 数学，无 OCCT）。几何本身（每个组件的
 * 三角网格）由内核 Worker 计算：syncScene 收集各组件特征 + 世界变换，一次性
 * 调 `kernel.assembly` 拿回可序列化的 MeshResult，再构造成 ShapeView。
 */
import * as THREE from 'three';
import { CadDocument, type SerializedDoc } from '../doc/model';
import { resolveExpressions } from '../doc/expr';
import { ShapeView, type DisplayStyle } from '../view/shapeview';
import { kernel } from '../core/kernel';
import type { MeshResult, BBox, AssemblyComponent } from '../core/kernel-types';
import { newId } from '../sketch/types';

export interface MateRef {
  comp: string;
  localPoint: [number, number, number];
  localDir: [number, number, number];
  isAxis?: boolean;
  kind?: 'planar' | 'cylindrical' | 'edge';
  /** 圆柱/圆的半径（仅用于显示与智能默认配合类型） */
  radius?: number;
}

/** 配合参考的可读描述（用于状态栏/对话框） */
export function mateRefLabel(r: MateRef): string {
  if (r.kind === 'cylindrical') return `圆柱/轴${r.radius !== undefined ? ` Φ${(r.radius * 2).toFixed(1)}` : ''}`;
  if (r.kind === 'edge') return '棱边';
  return '平面';
}

export type MateType = 'coincident' | 'concentric' | 'distance' | 'parallel' | 'perpendicular' | 'angle';

export interface Mate {
  id: string;
  type: MateType;
  a: MateRef;
  b: MateRef;
  value?: number;
  flip?: boolean;
  name: string;
  error?: string;
}

export interface Component {
  id: string;
  name: string;
  doc: CadDocument;
  position: [number, number, number];
  rotation: [number, number, number];
  visible: boolean;
  fixed: boolean;
  color?: number;
  view: ShapeView | null;
  /** 爆炸偏移方向（单位向量） */
  explodeDir?: [number, number, number];
  /** 上次同步得到的网格 / 包围盒 / 体积 */
  mesh?: MeshResult;
  bbox?: BBox;
  volume?: number;
  /** 网格对应的特征版本（避免重复向 Worker 请求） */
  meshRev?: number;
}

export const MATE_LABEL: Record<MateType, string> = {
  coincident: '重合',
  concentric: '同心',
  distance: '距离',
  parallel: '平行',
  perpendicular: '垂直',
  angle: '角度',
};

/** 装配体的可序列化形态（保存 / 撤销快照共用；不含 THREE 视图与网格缓存） */
export interface SerializedComponent {
  id: string;
  name: string;
  /** 组件自身的零件文档 */
  doc: SerializedDoc;
  position: [number, number, number];
  rotation: [number, number, number];
  visible: boolean;
  fixed: boolean;
  color?: number;
  explodeDir?: [number, number, number];
}

export interface SerializedAssembly {
  components: SerializedComponent[];
  mates: Mate[];
  explodeAmount: number;
}

/**
 * 深拷贝一条配合。
 * ⚠️ 不能只 `{...m}`：`a`/`b` 里的 `localPoint`/`localDir` 是数组，
 * 浅拷贝会让撤销快照与实时装配体**共享同一份坐标数组**，之后求解原地改写
 * 就会连快照一起改（撤销恢复不出旧值）—— 与 `doc.toJSON()` 必须真深拷贝同源。
 */
function cloneMate(m: Mate): Mate {
  return {
    ...m,
    a: { ...m.a, localPoint: [...m.a.localPoint], localDir: [...m.a.localDir] },
    b: { ...m.b, localPoint: [...m.b.localPoint], localDir: [...m.b.localDir] },
  };
}

export class Assembly {
  components: Component[] = [];
  mates: Mate[] = [];
  explodeAmount = 0;
  lastResidual = 0;

  /**
   * 序列化为纯数据。
   * ⚠️ 只存**能重建几何所需**的字段：视图 / 网格 / bbox 都是缓存，
   * 反序列化后由 `syncScene()` 重新向内核要（`view: null` → 进 needMesh 分支）。
   */
  toJSON(): SerializedAssembly {
    return {
      components: this.components.map((c) => ({
        id: c.id,
        name: c.name,
        doc: c.doc.toJSON(),
        position: [...c.position] as [number, number, number],
        rotation: [...c.rotation] as [number, number, number],
        visible: c.visible,
        fixed: c.fixed,
        ...(c.color !== undefined ? { color: c.color } : {}),
        ...(c.explodeDir ? { explodeDir: [...c.explodeDir] as [number, number, number] } : {}),
      })),
      mates: this.mates.map(cloneMate),
      explodeAmount: this.explodeAmount,
    };
  }

  /** 从纯数据重建（视图留空，需调用方再 `syncScene`） */
  static fromJSON(data: unknown): Assembly {
    const a = new Assembly();
    const rec = (data ?? null) as Partial<SerializedAssembly> | null;
    if (!rec) return a;
    if (Array.isArray(rec.components)) {
      for (const sc of rec.components) {
        if (!sc || typeof sc.id !== 'string') continue;
        a.components.push({
          id: sc.id,
          name: typeof sc.name === 'string' ? sc.name : '零件',
          doc: CadDocument.fromJSON(sc.doc),
          position: Array.isArray(sc.position) ? [...sc.position] as [number, number, number] : [0, 0, 0],
          rotation: Array.isArray(sc.rotation) ? [...sc.rotation] as [number, number, number] : [0, 0, 0],
          visible: sc.visible !== false,
          fixed: !!sc.fixed,
          ...(sc.color !== undefined ? { color: sc.color } : {}),
          ...(sc.explodeDir ? { explodeDir: [...sc.explodeDir] as [number, number, number] } : {}),
          view: null,
        });
      }
    }
    if (Array.isArray(rec.mates)) a.mates = (rec.mates as Mate[]).map(cloneMate);
    if (typeof rec.explodeAmount === 'number') a.explodeAmount = rec.explodeAmount;
    return a;
  }

  addComponent(doc: CadDocument, name?: string): Component {
    const c: Component = {
      id: newId('c'),
      name: name ?? `零件${this.components.length + 1}`,
      doc,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      visible: true,
      fixed: this.components.length === 0,
      view: null,
    };
    this.components.push(c);
    return c;
  }

  getComponent(id: string): Component | undefined {
    return this.components.find((c) => c.id === id);
  }

  removeComponent(id: string): void {
    this.components = this.components.filter((c) => c.id !== id);
    this.mates = this.mates.filter((m) => m.a.comp !== id && m.b.comp !== id);
  }

  // ------------------------------------------------------------
  // 矩阵
  // ------------------------------------------------------------
  matrixOf(c: Component): THREE.Matrix4 {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(c.rotation[0], c.rotation[1], c.rotation[2], 'XYZ'));
    m.compose(new THREE.Vector3(...c.position), q, new THREE.Vector3(1, 1, 1));
    return m;
  }

  /** 3×4 行主序（供内核 Worker 做世界变换） */
  private transform3x4(c: Component): number[] {
    const e = this.matrixOf(c).elements;
    return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]];
  }

  private explodeOffset(c: Component): THREE.Vector3 {
    if (!this.explodeAmount || !c.explodeDir) return new THREE.Vector3();
    return new THREE.Vector3(...c.explodeDir).multiplyScalar(this.explodeAmount);
  }

  displayMatrix(c: Component): THREE.Matrix4 {
    const m = this.matrixOf(c);
    const off = this.explodeOffset(c);
    if (off.lengthSq() > 0) m.premultiply(new THREE.Matrix4().makeTranslation(off.x, off.y, off.z));
    return m;
  }

  // ------------------------------------------------------------
  // 视图（几何由内核 Worker 提供）
  // ------------------------------------------------------------
  async syncScene(root: THREE.Object3D, style: DisplayStyle): Promise<void> {
    const alive = new Set<string>();
    // 先收集需要网格的组件（特征版本变化或尚无视图）
    const needMesh: Component[] = [];
    for (const c of this.components) {
      alive.add(c.id);
      const rev = c.doc.rebuildCount;
      if (c.view && c.meshRev === rev) {
        // 复用已有网格，仅更新变换/样式
      } else {
        needMesh.push(c);
      }
    }

    let partMap = new Map<string, { mesh: MeshResult; bbox: BBox; volume: number }>();
    if (needMesh.length) {
      const req: AssemblyComponent[] = needMesh.map((c) => ({
        id: c.id,
        features: resolveExpressions(c.doc).features,
        transform: this.transform3x4(c),
        color: c.color,
      }));
      const res = await kernel.assembly(req);
      for (const part of res.parts) partMap.set(part.id, part);
    }

    for (const c of this.components) {
      if (!c.visible) {
        if (c.view) {
          c.view.group.visible = false;
        }
        continue;
      }
      const rev = c.doc.rebuildCount;
      const part = partMap.get(c.id);
      if (part) {
        if (c.view) {
          c.view.group.removeFromParent();
          c.view.dispose();
        }
        const sv = new ShapeView(part.mesh, { style, bodyColor: c.color });
        sv.group.userData.compId = c.id;
        root.add(sv.group);
        c.view = sv;
        c.mesh = part.mesh;
        c.bbox = part.bbox;
        c.volume = part.volume;
        c.meshRev = rev;
      } else if (c.view && c.meshRev !== rev) {
        // 特征变了但 Worker 没返回（理论上不会发生），清理旧视图
        c.view.group.removeFromParent();
        c.view.dispose();
        c.view = null;
      }
      if (c.view) {
        c.view.applyStyle(style);
        c.view.group.matrixAutoUpdate = false;
        c.view.group.matrix.copy(this.displayMatrix(c));
        c.view.group.visible = c.visible;
      }
    }

    const views = new Set<THREE.Object3D>();
    for (const c of this.components) if (c.view) views.add(c.view.group);
    for (const child of [...root.children]) {
      const cid = child.userData?.compId;
      if (!cid) continue;
      // 已删除组件 → 摘除；或「同 compId 但不是当前视图」的孤儿 → 也摘除
      // （撤销会用 `fromJSON` 换掉整个 Assembly 实例，旧实例的 ShapeView 还挂在场景里）
      if (!alive.has(cid) || !views.has(child)) child.removeFromParent();
    }
  }

  /**
   * 丢弃全部视图（替换本实例前调用）。
   *
   * ⚠️ 撤销 / 打开项目都会用 `fromJSON` **新建** Assembly 实例；旧实例的 ShapeView
   * 仍挂在 `viewport.root` 上，没有引用再去 dispose → 几何/材质常驻显存（泄漏），
   * 且切换模式时新视图与孤儿视图并存。故换实例前必须显式收尾。
   */
  disposeViews(): void {
    for (const c of this.components) {
      if (!c.view) continue;
      c.view.group.removeFromParent();
      c.view.dispose();
      c.view = null;
      c.mesh = undefined;
      c.meshRev = undefined;
    }
  }

  // ------------------------------------------------------------
  // 配合求解（Gauss-Seidel，纯 three.js）
  // ------------------------------------------------------------
  private refWorld(r: MateRef): { p: THREE.Vector3; d: THREE.Vector3; m: THREE.Matrix4 } {
    const c = this.getComponent(r.comp);
    const m = c ? this.matrixOf(c) : new THREE.Matrix4();
    const p = new THREE.Vector3(...r.localPoint).applyMatrix4(m);
    const rot = new THREE.Matrix3().setFromMatrix4(m);
    const d = new THREE.Vector3(...r.localDir).applyMatrix3(rot).normalize();
    return { p, d, m };
  }

  private applyWorldRotation(c: Component, q: THREE.Quaternion, about: THREE.Vector3): void {
    const m = this.matrixOf(c);
    const pivot = new THREE.Matrix4().makeTranslation(about.x, about.y, about.z);
    const pivotInv = new THREE.Matrix4().makeTranslation(-about.x, -about.y, -about.z);
    const rot = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const next = pivot.clone().multiply(rot).multiply(pivotInv).multiply(m);
    this.decomposeTo(next, c);
  }

  private applyWorldTranslation(c: Component, v: THREE.Vector3): void {
    c.position = [c.position[0] + v.x, c.position[1] + v.y, c.position[2] + v.z];
  }

  private decomposeTo(m: THREE.Matrix4, c: Component): void {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    m.decompose(pos, quat, scl);
    const e = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
    c.position = [pos.x, pos.y, pos.z];
    c.rotation = [e.x, e.y, e.z];
  }

  solve(maxIter = 60): { residual: number; iterations: number } {
    let residual = 0;
    let iter = 0;
    for (; iter < maxIter; iter++) {
      let maxErr = 0;
      for (const mate of this.mates) {
        const err = this.solveMate(mate);
        maxErr = Math.max(maxErr, err);
      }
      residual = maxErr;
      if (maxErr < 1e-6) break;
    }
    this.lastResidual = residual;
    for (const m of this.mates) {
      m.error = residual > 1e-3 ? '配合未收敛（可能过约束）' : undefined;
    }
    return { residual, iterations: iter };
  }

  private solveMate(mate: Mate): number {
    const ca = this.getComponent(mate.a.comp);
    const cb = this.getComponent(mate.b.comp);
    if (!ca || !cb) return 0;
    const movable = !cb.fixed ? cb : !ca.fixed ? ca : null;
    if (!movable) return 0;
    const other = movable === cb ? ca : cb;
    const refM = movable === cb ? mate.b : mate.a;
    const refO = movable === cb ? mate.a : mate.b;
    const sign = movable === cb ? 1 : -1;

    const M = this.refWorld(refM);
    const O = this.refWorld(refO);

    switch (mate.type) {
      case 'coincident': {
        const targetDir = O.d.clone().multiplyScalar(mate.flip ? sign : -sign);
        const q = new THREE.Quaternion().setFromUnitVectors(M.d.clone().normalize(), targetDir.normalize());
        this.applyWorldRotation(movable, q, M.p);
        const M2 = this.refWorld(refM);
        const dist = M2.p.clone().sub(O.p).dot(O.d);
        this.applyWorldTranslation(movable, O.d.clone().multiplyScalar(-dist));
        return Math.abs(dist);
      }
      case 'distance': {
        const targetDir = O.d.clone().multiplyScalar(mate.flip ? sign : -sign);
        const q = new THREE.Quaternion().setFromUnitVectors(M.d.clone().normalize(), targetDir.normalize());
        this.applyWorldRotation(movable, q, M.p);
        const M2 = this.refWorld(refM);
        const want = (mate.value ?? 0) * sign;
        const dist = M2.p.clone().sub(O.p).dot(O.d) - want;
        this.applyWorldTranslation(movable, O.d.clone().multiplyScalar(-dist));
        return Math.abs(dist);
      }
      case 'concentric': {
        const dM = M.d.clone().normalize();
        const dO = O.d.clone().normalize();
        const dot = dM.dot(dO);
        const target = dot >= 0 ? dO.clone() : dO.clone().negate();
        const q = new THREE.Quaternion().setFromUnitVectors(dM, target);
        this.applyWorldRotation(movable, q, M.p);
        const M2 = this.refWorld(refM);
        const v = M2.p.clone().sub(O.p);
        const along = v.dot(dO);
        const perp = v.clone().addScaledVector(dO, -along);
        this.applyWorldTranslation(movable, perp.negate());
        return perp.length();
      }
      case 'parallel': {
        const dM = M.d.clone().normalize();
        const dO = O.d.clone().normalize();
        const target = mate.flip ? dO.clone().negate() : dO.clone();
        const q = new THREE.Quaternion().setFromUnitVectors(dM, target);
        this.applyWorldRotation(movable, q, M.p);
        return dM.angleTo(target);
      }
      case 'perpendicular': {
        const dM = M.d.clone().normalize();
        const dO = O.d.clone().normalize();
        const target = new THREE.Vector3().crossVectors(dO, new THREE.Vector3(0, 0, 1));
        if (target.lengthSq() < 1e-6) target.crossVectors(dO, new THREE.Vector3(1, 0, 0));
        target.normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(dM, target);
        this.applyWorldRotation(movable, q, M.p);
        return Math.abs(Math.PI / 2 - dM.angleTo(dO));
      }
      case 'angle': {
        const want = ((mate.value ?? 90) * Math.PI) / 180;
        const dM = M.d.clone().normalize();
        const dO = O.d.clone().normalize();
        const cur = dM.angleTo(dO);
        const axis = new THREE.Vector3().crossVectors(dM, dO);
        if (axis.lengthSq() < 1e-9) return 0;
        axis.normalize();
        const q = new THREE.Quaternion().setFromAxisAngle(axis, want - cur);
        this.applyWorldRotation(movable, q, M.p);
        return Math.abs(want - cur);
      }
      default:
        return 0;
    }
  }

  // ------------------------------------------------------------
  // 干涉检查（内核 Worker）
  // ------------------------------------------------------------
  async checkInterference(): Promise<{ a: string; b: string; volume: number }[]> {
    if (this.components.length < 2) return [];
    const req: AssemblyComponent[] = this.components.map((c) => ({
      id: c.id,
      features: resolveExpressions(c.doc).features,
      transform: this.transform3x4(c),
      color: c.color,
    }));
    const res = await kernel.interfere(req);
    const nameOf = (id: string) => this.getComponent(id)?.name ?? id;
    return res.pairs.map((p) => ({ a: nameOf(p.a), b: nameOf(p.b), volume: p.volume }));
  }

  // ------------------------------------------------------------
  // 爆炸
  // ------------------------------------------------------------
  autoExplodeDirs(): void {
    const centers = this.components.map((c) => {
      const bb = c.bbox ?? { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
      const cx = (bb.min[0] + bb.max[0]) / 2;
      const cy = (bb.min[1] + bb.max[1]) / 2;
      const cz = (bb.min[2] + bb.max[2]) / 2;
      const v = new THREE.Vector3(cx, cy, cz).applyMatrix4(this.matrixOf(c));
      return v;
    });
    const avg = centers.reduce((a, b) => a.add(b), new THREE.Vector3()).divideScalar(Math.max(centers.length, 1));
    this.components.forEach((c, i) => {
      const d = centers[i].clone().sub(avg);
      if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
      d.normalize();
      c.explodeDir = [d.x, d.y, d.z];
    });
  }

  setExplode(amount: number): void {
    if (!this.components.some((c) => c.explodeDir)) this.autoExplodeDirs();
    this.explodeAmount = amount;
  }

  // ------------------------------------------------------------
  // 统计
  // ------------------------------------------------------------
  stats(): { parts: number; mates: number; volume: number; bbox: { min: [number, number, number]; max: [number, number, number] } } {
    let volume = 0;
    for (const c of this.components) volume += c.volume ?? 0;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const c of this.components) {
      if (!c.bbox) continue;
      const m = this.matrixOf(c);
      for (const corner of [
        [c.bbox.min[0], c.bbox.min[1], c.bbox.min[2]],
        [c.bbox.max[0], c.bbox.max[1], c.bbox.max[2]],
        [c.bbox.min[0], c.bbox.max[1], c.bbox.min[2]],
        [c.bbox.max[0], c.bbox.min[1], c.bbox.max[2]],
      ]) {
        const v = new THREE.Vector3(corner[0], corner[1], corner[2]).applyMatrix4(m);
        min[0] = Math.min(min[0], v.x);
        min[1] = Math.min(min[1], v.y);
        min[2] = Math.min(min[2], v.z);
        max[0] = Math.max(max[0], v.x);
        max[1] = Math.max(max[1], v.y);
        max[2] = Math.max(max[2], v.z);
      }
    }
    if (!Number.isFinite(min[0])) {
      return { parts: this.components.length, mates: this.mates.length, volume: 0, bbox: { min: [-50, -50, -50], max: [50, 50, 50] } };
    }
    return { parts: this.components.length, mates: this.mates.length, volume, bbox: { min, max } };
  }

  insertFromDocument(doc: CadDocument, name?: string): Component {
    const copy = CadDocument.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    return this.addComponent(copy, name);
  }

  /**
   * 明细表行：按"特征序列相同"分组统计数量（同一零件插入多份时自动合并）。
   * 数量随组件增删自动联动。
   */
  bomEntries(): { name: string; qty: number; volume: number }[] {
    const groups = new Map<string, { name: string; qty: number; volume: number }>();
    for (const c of this.components) {
      // 按"解析后的特征 + 全局参数"分组：参数不同即视为不同零件
      const key = JSON.stringify({ f: resolveExpressions(c.doc).features, p: c.doc.params });
      const g = groups.get(key);
      if (g) {
        g.qty += 1;
        g.volume += c.volume ?? 0;
      } else {
        groups.set(key, { name: c.name, qty: 1, volume: c.volume ?? 0 });
      }
    }
    return [...groups.values()];
  }

  /** 各组件三角面数（用于信息展示） */
  meshes(): { name: string; triangles: number }[] {
    return this.components.map((c) => ({
      name: c.name,
      triangles: c.mesh ? new Uint32Array(c.mesh.indices).length / 3 : 0,
    }));
  }
}
