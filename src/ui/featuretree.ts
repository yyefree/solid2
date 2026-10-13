/**
 * 特征管理器（FeatureManager 设计树，SolidWorks 风格）。
 *
 * 结构自上而下：文档根 ▸ 注解 ▸ 材质 ▸（实体）▸ 历史特征（草图/拉伸…）▸ 基准面（前/上/右）▸ 原点。
 * 文件夹可折叠；特征节点支持双击编辑、右键菜单。
 * 保留 `.tree` / `.tnode` / `.label` / `.ic` 类名，兼容右键「展开所有」逻辑。
 */
import { el, clear } from './dom';
import { icon } from './icons';
import type { App } from '../app/app';
import { FEATURE_LABEL, FEATURE_ICON } from '../doc/types';
import { notify, confirmDialog } from './toast';
import { openFeatureContextMenu, openTreeContextMenu } from './contextmenu';

export function buildFeatureTree(app: App, host: HTMLElement): void {
  const render = () => {
    clear(host);
    const tree = el('div', { class: 'tree' });

    // 文档根
    const root = folder('零件1', 'part', [], false);
    tree.appendChild(root.node);

    // 注解
    root.children.appendChild(folder('注解', 'annotation2', [], true).node);
    // 材质
    root.children.appendChild(folder('材质 <未指定>', 'material', [], false).node);

    // 实体（有实体时）
    const solids = app.modelSummary().solids;
    if (solids > 0) {
      const bodies = folder('实体', 'solid', [], false);
      for (let i = 0; i < solids; i++) {
        bodies.children.appendChild(leaf('实体' + (i + 1), 'solid'));
      }
      root.children.appendChild(bodies.node);
    }

    // 历史特征
    const feats = app.doc.features;
    for (const f of feats) {
      const isSketch = f.type === 'sketch';
      const isActive = app.editingSketch?.id === f.id;
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
      node.addEventListener('dblclick', () => {
        if (isSketch && app.mode !== 'sketch') app.enterSketch(f as never);
        else notify.info(`已选中「${f.name}」，可在右侧属性面板修改参数`);
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

    // 基准面
    const planes = folder('基准面', 'plane', [], false);
    for (const [name, ic] of [
      ['前视基准面', 'front'],
      ['上视基准面', 'top'],
      ['右视基准面', 'right'],
    ] as [string, string][]) {
      planes.children.appendChild(leaf(name, ic));
    }
    root.children.appendChild(planes.node);

    // 原点
    root.children.appendChild(leaf('原点', 'origin'));

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
