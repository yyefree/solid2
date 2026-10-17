/**
 * 特征管理器（FeatureManager 设计树，SolidWorks 风格）。
 *
 * 结构自上而下（与 SolidWorks 零件树一致）：
 *   文档根 ▸ 注解 ▸ 材质 ▸（实体）▸ 基准面（前/上/右）▸ 草图/特征（按创建顺序平铺为根的直接子节点）▸ 原点（可折叠，展开为 X/Y/Z 轴）。
 *   草图与特征不再塞进「历史特征」文件夹，而是像 SolidWorks 那样按时间顺序直接挂在零件根下。
 *   文件夹可折叠；特征节点支持双击编辑、右键菜单。
 *   保留 `.tree` / `.tnode` / `.label` / `.ic` 类名，兼容右键「展开所有」逻辑。
 */
import { el, clear } from './dom';
import { icon } from './icons';
import type { AppApi } from '../app/app-api';
import { FEATURE_LABEL, FEATURE_ICON } from '../doc/types';
import { notify, confirmDialog } from './toast';
import { openFeatureContextMenu, openTreeContextMenu } from './contextmenu';

export function buildFeatureTree(app: AppApi, host: HTMLElement): void {
  const render = () => {
    clear(host);
    const tree = el('div', { class: 'tree' });

    // 文档根
    const root = folder('零件1', 'part', [], false);
    tree.appendChild(root.node);

    // 注解（可折叠文件夹，默认空）
    root.children.appendChild(folder('注解', 'annotation2', [], false).node);
    // 材质
    root.children.appendChild(leaf('材质 <未指定>', 'material'));

    // 实体（有实体时）
    const solids = app.modelSummary().solids;
    if (solids > 0) {
      const bodies = folder('实体', 'solid', [], false);
      for (let i = 0; i < solids; i++) {
        bodies.children.appendChild(leaf('实体' + (i + 1), 'solid'));
      }
      root.children.appendChild(bodies.node);
    }

    // 曲面实体（有曲面特征时；SolidWorks 同名文件夹）
    const surfaces = app.modelSummary().surfaces;
    if (surfaces > 0) {
      const surfBodies = folder('曲面实体', 'surface', [], false);
      for (let i = 0; i < surfaces; i++) {
        surfBodies.children.appendChild(leaf('曲面实体' + (i + 1), 'surface'));
      }
      root.children.appendChild(surfBodies.node);
    }

    // 基准面（前/上/右）
    const planes = folder('基准面', 'plane', [], false);
    for (const [name, ic] of [
      ['前视基准面', 'front'],
      ['上视基准面', 'top'],
      ['右视基准面', 'right'],
    ] as [string, string][]) {
      planes.children.appendChild(leaf(name, ic));
    }
    root.children.appendChild(planes.node);

    // 草图 / 特征：按创建顺序直接挂在零件根下（SolidWorks 风格，不再用「历史特征」文件夹）
    const feats = app.doc.features;
    for (const f of feats) {
      const isSketch = f.type === 'sketch';
      // 编辑中的草图 / 当前选中的特征都高亮（退出草图后该草图被选中，应显示为选中态）
      const isActive = app.editingSketch?.id === f.id || app.selectedFeatureId === f.id;
      const node = el(
        'div',
        {
          class: `tnode feat ${f.error ? 'err' : ''} ${f.suppressed ? 'suppressed' : ''} ${isActive ? 'sel' : ''}`.trim(),
          dataset: { id: f.id },
        },
        el('span', { class: 'tw' }),
        el('span', { class: 'ic', html: icon(FEATURE_ICON[f.type] ?? 'part', 15) }),
        el('span', { class: 'label', text: f.name }),
        f.error ? el('span', { class: 'badge', text: '!' }) : null
      );
      node.addEventListener('click', () => {
        app.selectFeature(f.id);
      });
      node.addEventListener('dblclick', () => {
        if (isSketch && app.mode !== 'sketch') app.enterSketch(f as never);
        else notify.info(`已选中「${f.name}」，可在左侧属性管理器修改参数`);
      });
      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openFeatureContextMenu(app, f.id, e.clientX, e.clientY);
      });
      root.children.appendChild(node);
    }
    if (!feats.length) {
      root.children.appendChild(el('div', { class: 'hint', text: '特征树为空。先创建草图，再添加拉伸/旋转等特征。' }));
    }

    // 原点（可折叠，展开为 X/Y/Z 三个轴 —— SolidWorks 零件树原点结构）
    const origin = folder('原点', 'origin', [], true);
    for (const ax of ['X 轴', 'Y 轴', 'Z 轴']) {
      origin.children.appendChild(leaf(ax, 'axis'));
    }
    root.children.appendChild(origin.node);

    host.appendChild(tree);
  };

  render();
  app.on('tree', render);
  app.on('mode', render);
  app.on('change', render);
  app.on('props', render);

  // 设计树空白处右键：整体插入菜单
  host.addEventListener('contextmenu', (e) => {
    if ((e.target as HTMLElement).closest('.tnode')) return; // 特征节点自行处理
    e.preventDefault();
    openTreeContextMenu(app, e.clientX, e.clientY);
  });
}

// -------- 内部工具 --------
interface Folder {
  node: HTMLElement;
  children: HTMLElement;
}

function folder(label: string, ic: string, _children: never[], collapsed: boolean): Folder {
  const caret = el('span', { class: `caret ${collapsed ? 'collapsed' : ''}`, html: icon(collapsed ? 'caretRight' : 'caretDown', 12) });
  const node = el(
    'div',
    { class: `tnode folder ${collapsed ? 'collapsed' : ''}`.trim() },
    caret,
    el('span', { class: 'ic', html: icon(ic, 15) }),
    el('span', { class: 'label', text: label })
  );
  const children = el('div', { class: 'tree-children' });
  node.appendChild(children);

  const toggle = () => {
    const c = node.classList.toggle('collapsed');
    caret.className = `caret ${c ? 'collapsed' : ''}`;
    caret.innerHTML = icon(c ? 'caretRight' : 'caretDown', 12);
  };
  node.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.tree-children')) return;
    toggle();
  });
  return { node, children };
}

function leaf(label: string, ic: string): HTMLElement {
  return el(
    'div',
    { class: 'tnode leaf' },
    el('span', { class: 'tw' }),
    el('span', { class: 'ic', html: icon(ic, 15) }),
    el('span', { class: 'label', text: label })
  );
}
