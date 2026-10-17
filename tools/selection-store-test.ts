/**
 * 选中态唯一真源单测（纯计算）。
 *
 * 覆盖 `src/app/selection-store.ts` 的核心不变量：
 *   - 特征选择 ⇄ 几何选择互斥（选中一方即清空另一方）
 *   - 非叠加选择只保留本次点击；叠加选择同类内切换
 *   - 选择过滤器拒绝时不产生任何副作用
 *   - 悬空引用剪除（撤销/重做/删除特征后）
 *
 * 与 `App`（依赖 DOM / THREE / 内核）分离——本测试只测纯状态机。
 */
import { SelectionStore, emptyGeomSelection } from '../src/app/selection-store';

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

// ---- 初始状态 ----
{
  const s = new SelectionStore();
  check('初始无特征选中、无几何选中、无草图',
    s.featureId === null && !s.hasGeometry && s.activeSketchId === null && s.editingSketchId === null,
    `feat=${s.featureId} count=${s.count}`);
  check('默认过滤器为 all（不过滤，行为不变）', s.selectionFilter === 'all', s.selectionFilter);
  check('all 过滤器允许全部四类几何',
    s.allows('face') && s.allows('edge') && s.allows('vertex') && s.allows('body'));
}

// ---- 特征选择 ⇄ 几何选择互斥 ----
{
  const s = new SelectionStore();
  s.selectGeom('face', 3, false);
  check('选中面后 hasGeometry=true', s.hasGeometry && s.count === 1, `count=${s.count}`);
  s.selectFeature('f1');
  check('选中特征 → 自动清空几何选择（互斥）', s.featureId === 'f1' && !s.hasGeometry && s.count === 0,
    `feat=${s.featureId} count=${s.count}`);
  s.selectGeom('edge', 7, false);
  check('选中边 → 自动清空特征选择（互斥）', s.featureId === null && s.count === 1 && s.geometry.edges[0] === 7,
    `feat=${s.featureId} edges=${JSON.stringify(s.geometry.edges)}`);
}

// ---- selectFeature(null) 只清特征，不动几何（几何选择路径依赖这一点）----
{
  const s = new SelectionStore();
  s.selectGeom('face', 2, false);
  s.selectFeature(null);
  check('selectFeature(null) 只取消特征选中、不动几何选择',
    s.featureId === null && s.hasGeometry && s.geometry.faces[0] === 2,
    `feat=${s.featureId} faces=${JSON.stringify(s.geometry.faces)}`);
}

// ---- 非叠加选择：清空其它所有类别 ----
{
  const s = new SelectionStore();
  s.selectGeom('face', 1, false);
  s.selectGeom('face', 2, true);
  check('叠加选择同类内累积', s.geometry.faces.length === 2, JSON.stringify(s.geometry.faces));
  s.selectGeom('edge', 5, false);
  check('非叠加选择边 → 清空面、只留本次边',
    s.geometry.faces.length === 0 && s.geometry.edges.length === 1 && s.geometry.edges[0] === 5,
    `faces=${s.geometry.faces.length} edges=${JSON.stringify(s.geometry.edges)}`);
  s.selectGeom('vertex', 9, false);
  check('非叠加选择点 → 清空面与边（统一语义）',
    s.geometry.faces.length === 0 && s.geometry.edges.length === 0 && s.geometry.vertices[0] === 9,
    `f=${s.geometry.faces.length} e=${s.geometry.edges.length} v=${JSON.stringify(s.geometry.vertices)}`);
}

// ---- 叠加选择：已选则取消 ----
{
  const s = new SelectionStore();
  s.selectGeom('face', 4, false);
  s.selectGeom('face', 4, true);
  check('叠加点击已选元素 → 取消该元素', s.geometry.faces.length === 0, JSON.stringify(s.geometry.faces));
  s.selectGeom('body', 0, false);
  s.selectGeom('body', 1, true);
  check('实体叠加选择累积', s.geometry.bodies.length === 2, JSON.stringify(s.geometry.bodies));
}

// ---- 选择过滤器 ----
{
  const s = new SelectionStore();
  s.setSelectionFilter('edge');
  check('edge 过滤器只允许边', s.allows('edge') && !s.allows('face') && !s.allows('vertex') && !s.allows('body'));
  const accepted = s.selectGeom('face', 1, false);
  check('过滤器拒绝时不产生副作用（返回 false 且选择为空）', accepted === false && !s.hasGeometry,
    `accepted=${accepted} count=${s.count}`);
  const ok = s.selectGeom('edge', 2, false);
  check('过滤器允许时正常选中（返回 true）', ok === true && s.geometry.edges[0] === 2, `edges=${JSON.stringify(s.geometry.edges)}`);

  s.setSelectionFilter('vertex');
  check('vertex 过滤器：边被拒、点被接受', s.selectGeom('edge', 3, false) === false && s.selectGeom('vertex', 8, false) === true);
  s.setSelectionFilter('body');
  check('body 过滤器：点被拒、实体被接受', s.selectGeom('vertex', 1, false) === false && s.selectGeom('body', 0, false) === true);
  s.setSelectionFilter('all');
  check('回到 all：全部类别重新可选中', s.selectGeom('face', 1, false) === true && s.selectGeom('edge', 1, false) === true);
}

// ---- setGeometry（全选）也遵守互斥 ----
{
  const s = new SelectionStore();
  s.selectFeature('f9');
  s.setGeometry({ faces: [0, 1, 2], edges: [], vertices: [], bodies: [] });
  check('setGeometry 清空特征选择（互斥）且写入几何', s.featureId === null && s.geometry.faces.length === 3,
    `feat=${s.featureId} faces=${s.geometry.faces.length}`);
  const src = { faces: [7], edges: [], vertices: [], bodies: [] };
  s.setGeometry(src);
  src.faces.push(8);
  check('setGeometry 复制入参（外部数组后续改动不影响内部）', s.geometry.faces.length === 1, JSON.stringify(s.geometry.faces));
}

// ---- clearGeometry ----
{
  const s = new SelectionStore();
  s.selectGeom('face', 1, false);
  s.clearGeometry();
  check('clearGeometry 清空几何但不动特征', s.featureId === null && !s.hasGeometry && s.count === 0);
}

// ---- 草图状态 ----
{
  const s = new SelectionStore();
  s.setEditingSketch('sk1');
  check('进入草图编辑 → 同时设为「当前草图」', s.editingSketchId === 'sk1' && s.activeSketchId === 'sk1' && s.isEditingSketch);
  s.setActiveSketch('sk2');
  check('单独设置当前草图不影响编辑中草图', s.activeSketchId === 'sk2' && s.editingSketchId === 'sk1');
  s.setEditingSketch(null);
  check('退出草图编辑 → editingSketchId 清空、当前草图保留', s.editingSketchId === null && s.activeSketchId === 'sk2' && !s.isEditingSketch);
}

// ---- 悬空引用剪除 ----
{
  const s = new SelectionStore();
  s.selectFeature('gone');
  s.setActiveSketch('gone');
  const changed = s.prune((id) => id !== 'gone');
  check('prune 清掉指向已不存在特征的引用并报告变化',
    changed === true && s.featureId === null && s.activeSketchId === null,
    `changed=${changed} feat=${s.featureId} active=${s.activeSketchId}`);
  check('prune 无悬空时返回 false（不误报变化）', s.prune(() => true) === false);

  const s2 = new SelectionStore();
  s2.selectFeature('alive');
  check('prune 保留仍存在的特征引用', s2.prune((id) => id === 'alive') === false && s2.featureId === 'alive');
}

// ---- 叠加选择跨类别保留 / 过滤器拒绝保留特征 / prune 剪 editingSketch ----
{
  const s = new SelectionStore();
  s.selectGeom('face', 1, true);
  s.selectGeom('edge', 2, true);
  check('叠加选择跨类别保留（面 + 边同时存在）',
    s.geometry.faces.length === 1 && s.geometry.edges.length === 1,
    JSON.stringify(s.geometry));

  s.selectFeature('f1');
  // 切到 edge 过滤器后面被拒（顶点不在允许列表）——已选特征必须保留
  s.setSelectionFilter('edge');
  check('过滤器拒绝时不清已选特征（无副作用）',
    s.selectGeom('vertex', 3, false) === false && s.featureId === 'f1');

  const s2 = new SelectionStore();
  s2.setEditingSketch('sk-gone');
  check('prune 剪掉悬空的 editingSketch（切文档等路径）',
    s2.prune(() => false) === true && s2.editingSketchId === null && !s2.isEditingSketch,
    `editing=${s2.editingSketchId}`);
}

// ---- reset ----
{
  const s = new SelectionStore();
  s.selectFeature('f1');
  s.setActiveSketch('sk1');
  s.setEditingSketch('sk1');
  s.setSelectionFilter('edge');
  s.reset();
  check('reset 清空全部选中态', s.featureId === null && s.activeSketchId === null && s.editingSketchId === null && !s.hasGeometry);
  check('reset 保留选择过滤器（过滤器是工具设置，跨文档保留）', s.selectionFilter === 'edge', s.selectionFilter);
}

// ---- emptyGeomSelection 每次返回独立对象 ----
{
  const a = emptyGeomSelection();
  const b = emptyGeomSelection();
  a.faces.push(1);
  check('emptyGeomSelection 返回独立对象（无共享可变状态）', b.faces.length === 0);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
