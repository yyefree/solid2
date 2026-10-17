/**
 * 右侧任务窗格（SolidWorks Task Pane）—— 右侧竖排选项卡：
 *   SolidWorks 资源 · 设计库 · 文件浏览器 · 视图调色板 · 自定义属性。
 * 同时导出左侧「配置管理器」面板的极简实现。
 */
import { el, clear } from './dom';
import { icon } from './icons';
import type { AppApi } from '../app/app-api';

const TASK_TABS = [
  { id: 'resources', ic: 'about', label: 'SolidWorks 资源' },
  { id: 'designlib', ic: 'folder', label: '设计库' },
  { id: 'explorer', ic: 'folder', label: '文件浏览器' },
  { id: 'palette', ic: 'projectedView', label: '视图调色板' },
  { id: 'props', ic: 'smartDim', label: '自定义属性' },
] as const;

function hint(text: string): HTMLElement {
  return el('div', { class: 'hint', text });
}

function renderResources(_app: AppApi): HTMLElement {
  const wrap = el('div', { class: 'col tp-resources' });
  wrap.appendChild(el('div', { class: 'tp-logo', text: 'Solid2' }));
  wrap.appendChild(el('div', { class: 'hint', text: '参数化三维 CAD · OpenCASCADE 几何内核（WebAssembly）· 界面按 SolidWorks 布局复刻。' }));
  wrap.appendChild(el('div', { class: 'tp-res-h', text: '快速上手' }));
  const list = el('div', { class: 'tp-links' });
  for (const t of [
    '七菜单 + CommandManager：与 SolidWorks 一致的功能分区',
    'Heads-up 视图工具栏：显示样式 / 布景 / 剖面 / 视图定向',
    '视图立方 + 指北罗盘：点击面切标准视图，拖动罗盘旋转',
    'S 键快捷方式栏 · 右键鼠标手势 · 空格视图定向 · F 整屏',
  ]) {
    list.appendChild(el('div', { class: 'tp-link', text: '· ' + t }));
  }
  wrap.appendChild(list);
  return wrap;
}

function renderPalette(app: AppApi): HTMLElement {
  if (app.mode === 'drawing' && app.drawing) {
    const wrap = el('div', { class: 'col' });
    wrap.appendChild(el('div', { class: 'tp-res-h', text: `视图调色板（${app.drawing.views.length} 个视图）` }));
    const list = el('div', { class: 'list' });
    app.drawing.views.forEach((v, i) => {
      list.appendChild(el('div', { class: 'list-item' }, el('span', { text: (v as unknown as { viewId?: string }).viewId ?? `视图 ${i + 1}` })));
    });
    wrap.appendChild(list);
    wrap.appendChild(el('div', { class: 'hint', text: '可将视图拖入图纸以生成工程图视图。' }));
    return wrap;
  }
  return hint('在「工程图」模式下，可从视图调色板把视图拖入图纸。');
}

function renderCustomProps(app: AppApi): HTMLElement {
  const wrap = el('div', { class: 'col' });
  wrap.appendChild(el('div', { class: 'tp-res-h', text: '自定义属性' }));
  const tbl = el('div', { class: 'kv' });
  const rows: [string, string][] = [
    ['零件代号', '—'],
    ['描述', '—'],
    ['材料', '未指定'],
    ['质量', app.hasModel ? '（生成中）' : '—'],
  ];
  for (const [k, v] of rows) {
    tbl.appendChild(el('div', { class: 'kv-row' }, el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v })));
  }
  wrap.appendChild(tbl);
  wrap.appendChild(el('div', { class: 'hint', text: '自定义属性可用于工程图标题栏与 BOM 联动。' }));
  return wrap;
}

export function buildTaskPane(app: AppApi, host: HTMLElement): void {
  const content = el('div', { class: 'tp-content' });
  const strip = el('div', { class: 'tp-strip' });
  host.append(content, strip);

  const btns = new Map<string, HTMLElement>();
  let active = 'resources';

  const render = (id: string): HTMLElement => {
    switch (id) {
      case 'designlib': return hint('设计库为空。SolidWorks 设计库用于存放可复用的零件 / 特征 / 草图。');
      case 'explorer': return hint('文件浏览器：当前项目尚未保存为本地文件。');
      case 'palette': return renderPalette(app);
      case 'props': return renderCustomProps(app);
      default: return renderResources(app);
    }
  };

  const setTab = (id: string) => {
    active = id;
    for (const [k, b] of btns) b.classList.toggle('active', k === id);
    clear(content);
    content.appendChild(render(id));
  };

  for (const t of TASK_TABS) {
    const b = el(
      'button',
      { class: 'tp-tab', type: 'button', title: t.label },
      el('span', { class: 'ic', html: icon(t.ic, 18) })
    );
    b.addEventListener('click', () => setTab(t.id));
    btns.set(t.id, b);
    strip.appendChild(b);
  }
  setTab('resources');

  app.on('drawing', () => {
    if (active === 'palette') setTab('palette');
  });
}

/** 左侧「配置管理器」面板（SolidWorks ConfigurationManager）—— 极简实现 */
export function buildConfigPanel(app: AppApi, host: HTMLElement): void {
  const render = () => {
    clear(host);
    const wrap = el('div', { class: 'col' });
    wrap.appendChild(el('div', { class: 'tp-res-h', text: '配置' }));
    const list = el('div', { class: 'list' });
    list.appendChild(el('div', { class: 'list-item' }, el('span', { text: '默认 <默认>' }), el('span', { class: 'tag g', text: '激活' })));
    wrap.appendChild(list);
    wrap.appendChild(el('div', { class: 'hint', text: '配置可用于在同一文档中保存零件/装配体的多个版本。' }));
    wrap.appendChild(el('div', { class: 'field' }, el('label', { text: '' }), el('div', { class: 'val' }, (() => {
      const add = el('button', { class: 'btn', type: 'button', text: '添加配置…' });
      add.addEventListener('click', () => {
        app.setStatus('配置功能为占位实现（参考 SolidWorks 配置管理器）', 'ok');
      });
      return add;
    })())));
    host.appendChild(wrap);
  };
  render();
  app.on('tree', render);
}
