/**
 * 视图层材质与配色。
 */
import * as THREE from 'three';

export const COLORS = {
  body: 0xc8d0d8,
  bodyMetal: 0xb9c3cd,
  edge: 0x2b3542,
  edgeSoft: 0x55616f,
  selectFace: 0x2b7de9,
  selectEdge: 0xff8a1f,
  preview: 0x2b7de9,
  previewInvalid: 0xd9432f,
  ghost: 0x8fa0b3,
  sketch: 0x1f6fd6,
  sketchConstruction: 0x8b96a3,
  sketchPoint: 0x1f2733,
  sketchSelected: 0xff8a1f,
  dimension: 0xb53322,
  mate: 0x8a5cf6,
};

/** 实体主材质（CAD 常见的浅灰哑光） */
export function bodyMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: COLORS.body,
    metalness: 0.22,
    roughness: 0.55,
    flatShading: false,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

export function ghostMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: COLORS.ghost,
    metalness: 0.1,
    roughness: 0.85,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export function previewMaterial(valid = true): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: valid ? COLORS.preview : COLORS.previewInvalid,
    metalness: 0.1,
    roughness: 0.6,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export function edgeMaterial(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color: COLORS.edge, transparent: true, opacity: 0.85 });
}

export function softEdgeMaterial(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color: COLORS.edgeSoft, transparent: true, opacity: 0.4 });
}

/** 面高亮：把选中面单独描一层半透明蓝 */
export function highlightFaceMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: COLORS.selectFace,
    transparent: true,
    opacity: 0.34,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
}

export function highlightEdgeMaterial(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color: COLORS.selectEdge, linewidth: 2 });
}

export function sketchMaterial(
  selected = false,
  construction = false,
  display = false
): THREE.LineBasicMaterial {
  if (selected) return new THREE.LineBasicMaterial({ color: COLORS.sketchSelected, linewidth: 2 });
  if (construction) {
    return new THREE.LineDashedMaterial({
      color: COLORS.sketchConstruction,
      dashSize: 2.4,
      gapSize: 1.6,
    });
  }
  // 模型态显示：草图退出后仍可见，用暗色与激活编辑态区分（SolidWorks 行为）
  if (display) return new THREE.LineBasicMaterial({ color: COLORS.ghost });
  return new THREE.LineBasicMaterial({ color: COLORS.sketch });
}
