/**
 * three.js 对象销毁助手。
 *
 * `Object3D` 本身没有 geometry / material（Mesh / Line / Points 才有），
 * 且 material 可能是 `Material[]`。这里用鸭子类型 cast 统一处理，
 * 保持与旧实现（`as any` + 可选链）完全一致的运行期行为：
 * 数组材质无 `dispose` 方法 → 可选调用直接跳过。
 */

import * as THREE from 'three';

/** 销毁单个 three 对象的几何体与材质（若存在） */
export function disposeGeomAndMaterial(o: THREE.Object3D): void {
  const m = o as Partial<THREE.Mesh>;
  m.geometry?.dispose?.();
  (m.material as THREE.Material | undefined)?.dispose?.();
}

/** 逐个弹出并销毁一组子对象（高亮/预览清理用） */
export function disposeGroupChildren(g: THREE.Object3D): void {
  while (g.children.length) {
    const c = g.children.pop() as THREE.Object3D;
    disposeGeomAndMaterial(c);
  }
}
