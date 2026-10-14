/**
 * 顶部菜单栏 —— 复刻 SolidWorks 的「文件 / 编辑 / 视图 / 插入 / 工具 / 窗口 / 帮助」。
 *
 * 细节对齐 SolidWorks：
 *   · 每个菜单项带助记符下划线（文件(F)），按 Alt+F 可直接打开；
 *   · 菜单项左侧是图标，右侧是快捷键文本；
 *   · 复选/单选项显示 ✓ / ●；
 *   · 最左侧是产品标志按钮（对应 SolidWorks 的 S 标志菜单）；
 *   · 最右侧是「搜索命令」输入框。
 */
import { el } from './dom';
import { icon } from './icons';
import type { App } from '../app/app';
import { featureDialogs } from './dialogs';
import { openMeasure } from './measure';
import { openPopup, type PopupItem } from './popup';
import { sc, hotkeyGroups } from '../app/hotkeys';
import { notify, tableModal, modal } from './toast';
import { openViewSettings } from './headsup';
import { openAiModeling, openAiHelp } from './aipanel';
import { UNIT_SYSTEMS } from '../core/units';
import { ribbonController } from './ribbon';

const D = featureDialogs;

interface MenuDef {
  /** 助记符字母（大写） */
  accel: string;
  label: string;
  items: () => PopupItem[];
}

export function buildMenubar(app: App, host: HTMLElement): void {
  // ---------- 产品标志按钮 ----------
  const brand = el(
    'button',
    { class: 'menu-brand', type: 'button', title: 'Solid2 菜单' },
    el('span', { class: 'brand-mark', text: 'S' }),
    el('span', { class: 'brand-name', text: 'Solid' }, el('b', { text: '2' }))
  );
  brand.addEventListener('click', () => {
    const r = brand.getBoundingClientRect();
    openPopup(
      [
        { label: '新建', icon: 'new', sc: sc('file.new'), run: () => app.newDocument('model') },
        { label: '打开…', icon: 'open', sc: sc('file.open'), run: () => app.openProject() },
        { label: '保存', icon: 'save', sc: sc('file.save'), run: () => app.saveProject() },
        { sep: true },
        { label: '参数表…', icon: 'smartDim', run: () => D.parameterTable(app) },
        { label: '视图设置…', icon: 'viewSettings', run: () => openViewSettings(app) },
        { label: '快捷键一览…', icon: 'help', run: () => showHotkeyHelp(app) },
        { sep: true },
        { label: '关于 Solid2…', icon: 'about', run: () => showAbout() },
      ],
      r.left,
      r.bottom,
      { minWidth: 210 }
    );
  });
  host.appendChild(brand);

  // ---------- 七个菜单 ----------
  const menus: MenuDef[] = [
    { accel: 'F', label: '文件', items: () => fileMenu(app) },
    { accel: 'E', label: '编辑', items: () => editMenu(app) },
    { accel: 'V', label: '视图', items: () => viewMenu(app) },
    { accel: 'I', label: '插入', items: () => insertMenu(app) },
    { accel: 'T', label: '工具', items: () => toolsMenu(app) },
    { accel: 'W', label: '窗口', items: () => windowMenu(app) },
    { accel: 'H', label: '帮助', items: () => helpMenu(app) },
  ];

  const buttons = new Map<string, HTMLElement>();
  let open: (() => void) | null = null;

  for (const m of menus) {
    const btn = el(
      'button',
      { class: 'menu-item', type: 'button' },
      el('span', { class: 'mi-label', text: m.label }),
      el('span', { class: 'mi-accel', text: `(${m.accel})` })
    );
    buttons.set(m.accel, btn);
    btn.addEventListener('click', () => {
      open?.();
      const r = btn.getBoundingClientRect();
      btn.classList.add('open');
      open = openPopup(m.items(), r.left, r.bottom, {
        minWidth: 250,
        onClose: () => {
          btn.classList.remove('open');
          open = null;
        },
      });
    });
    // 悬停切换（已经打开一个菜单时）
    btn.addEventListener('mouseenter', () => {
      if (!open) return;
      const wasOpen = open;
      const r = btn.getBoundingClientRect();
      btn.classList.add('open');
      open = openPopup(m.items(), r.left, r.bottom, {
        minWidth: 250,
        onClose: () => {
          btn.classList.remove('open');
          open = null;
        },
      });
      wasOpen();
    });
    host.appendChild(btn);
  }

  // Alt + 助记符
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const btn = buttons.get(e.key.toUpperCase());
    if (!btn) return;
    e.preventDefault();
    btn.click();
  });

  // Standard 工具栏「帮助」按钮 → 弹出快捷键一览
  window.addEventListener('solid2:help', () => showHotkeyHelp(app));

  // ---------- 搜索命令 ----------
  const spacer = el('div', { class: 'menu-spacer' });
  host.appendChild(spacer);

  const searchWrap = el('div', { class: 'menu-search' }, el('span', { class: 'ic', html: icon('search', 14) }));
  const input = el('input', {
    class: 'menu-search-input',
    type: 'text',
    placeholder: '搜索命令',
    title: '输入命令名称快速定位（如「拉伸」「圆角」「重建」）',
  }) as HTMLInputElement;
  searchWrap.appendChild(input);
  host.appendChild(searchWrap);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      input.blur();
    }
    if (e.key === 'Enter') {
      const hit = searchCommand(input.value.trim());
      if (hit) {
        input.value = '';
        hit();
      } else {
        notify.info(`没有找到「${input.value.trim()}」对应的命令`);
      }
    }
  });
}

// ============================================================
// 各菜单内容
// ============================================================
function fileMenu(app: App): PopupItem[] {
  return [
    { label: '新建', icon: 'new', sc: sc('file.new'), run: () => app.newProject() },
    { label: '打开…', icon: 'open', sc: sc('file.open'), run: () => app.openProject() },
    { label: '保存', icon: 'save', sc: sc('file.save'), run: () => app.saveProject() },
    { label: '另存为…', icon: 'saveAs', run: () => app.saveProject() },
    { sep: true },
    { label: '打印…', icon: 'print', sc: sc('file.print'), run: () => app.printView() },
    { sep: true },
    {
      label: '导入',
      icon: 'importIcon',
      submenu: [
        { label: 'STEP / STP 文件…', icon: 'importIcon', run: () => app.importStepFile() },
        { label: 'Solid2 项目（JSON）…', icon: 'open', run: () => app.openProject() },
        { label: 'STL / OBJ…', icon: 'importIcon', disabled: true },
      ],
    },
    {
      label: '导出',
      icon: 'export',
      submenu: [
        { label: 'STEP…', icon: 'export', run: () => app.exportStep() },
        { label: 'STL…', icon: 'save', run: () => app.exportStl() },
        { label: 'OBJ…', icon: 'saveAs', run: () => app.exportObj() },
        { label: '工程图 SVG…', icon: 'export', run: () => D.exportDrawingSVG(app) },
        { label: '工程图 PNG…', icon: 'saveAs', run: () => void D.exportDrawingPNG(app) },
      ],
    },
    { sep: true },
    { label: '属性…', icon: 'info', sc: sc('edit.properties'), run: () => app.showProperties() },
    { sep: true },
    { label: '退出', icon: 'closeDoc', run: () => window.close() },
  ];
}

function editMenu(app: App): PopupItem[] {
  return [
    { label: '撤销', icon: 'undo', sc: sc('edit.undo'), disabled: !app.canUndo, run: () => app.undo() },
    { label: '重做', icon: 'redo', sc: sc('edit.redo'), disabled: !app.canRedo, run: () => app.redo() },
    { sep: true },
    { label: '剪切', icon: 'cut', sc: sc('edit.cut'), run: () => void app.cutSelection() },
    { label: '复制', icon: 'copy', sc: sc('edit.copy'), run: () => void app.copySelection() },
    { label: '粘贴', icon: 'paste', sc: sc('edit.paste'), run: () => void app.pasteFromClipboard() },
    { label: '删除', icon: 'trash', sc: sc('edit.delete'), run: () => app.deleteSelection() },
    { sep: true },
    { label: '全选', icon: 'check', sc: sc('edit.selectAll'), run: () => app.selectAll() },
    { sep: true },
    { label: '重建模型', icon: 'rebuild', sc: sc('view.rebuild'), run: () => app.rebuildModel() },
    { label: '强制重建', icon: 'rebuildModel', sc: sc('view.forceRebuild'), run: () => app.forceRebuild() },
    { label: '重绘屏幕', icon: 'displayStyle2', sc: sc('view.redraw'), run: () => app.redraw() },
    { sep: true },
    {
      label: '草图工具',
      icon: 'sketch',
      submenu: [
        { label: '智能尺寸', icon: 'smartDim', sc: sc('sk.dim'), run: () => D.smartDimension(app) },
        { label: '剪裁实体', icon: 'trim', sc: sc('sk.trim'), run: () => D.deleteSketchSelection(app) },
        { label: '构造几何线', icon: 'construction', run: () => D.toggleConstruction(app) },
        { label: '镜像实体', icon: 'mirrorEntities', run: () => D.mirrorEntities(app) },
      ],
    },
  ];
}

function viewMenu(app: App): PopupItem[] {
  const mk = (label: string, ic: string, style: string): PopupItem => ({
    label,
    icon: ic,
    checked: app.displayStyle === style,
    run: () => app.setDisplayStyle(style as never),
  });
  return [
    {
      label: '视图定向',
      icon: 'viewOrient',
      sc: sc('view.orientation'),
      submenu: [
        { label: '前视', icon: 'front', sc: sc('view.front'), run: () => app.setView('front') },
        { label: '后视', icon: 'front', sc: sc('view.back'), run: () => app.setView('back') },
        { label: '左视', icon: 'left', sc: sc('view.left'), run: () => app.setView('left') },
        { label: '右视', icon: 'right', sc: sc('view.right'), run: () => app.setView('right') },
        { label: '俯视', icon: 'top', sc: sc('view.top'), run: () => app.setView('top') },
        { label: '仰视', icon: 'top', sc: sc('view.bottom'), run: () => app.setView('bottom') },
        { label: '等轴测', icon: 'isometric', sc: sc('view.iso'), run: () => app.setView('iso') },
        { sep: true },
        { label: '正视于', icon: 'normalTo', sc: sc('view.normalTo'), run: () => app.normalToSelection() },
      ],
    },
    {
      label: '显示样式',
      icon: 'displayStyle2',
      submenu: [
        mk('带边线上色', 'shaded', 'shadedEdges'),
        mk('上色', 'realview', 'shaded'),
        mk('消除隐藏线', 'hiddenLines', 'hidden'),
        mk('线架图', 'wireframe', 'wireframe'),
        mk('透明', 'transparency', 'transparent'),
      ],
    },
    {
      label: '隐藏 / 显示项目',
      icon: 'hideShowItems',
      submenu: [
        { label: '基准面', icon: 'plane', checked: app.showPlanes, run: () => app.togglePlanes(!app.showPlanes) },
        { label: '网格', icon: 'grid', checked: app.showGrid, run: () => app.toggleGrid(!app.showGrid) },
        { label: '原点', icon: 'origin', checked: app.showOrigin, run: () => app.toggleOrigin(!app.showOrigin) },
      ],
    },
    {
      label: '应用布景',
      icon: 'applyScene',
      submenu: (['默认', '单色灰', '深色', '白色'] as const).map((n) => ({
        label: n,
        icon: 'applyScene',
        checked: app.sceneName === n,
        run: () => app.setScene(n),
      })),
    },
    {
      label: '剖面视图',
      icon: 'sectionCut',
      submenu: [
        { label: '关闭剖面', icon: 'sectionCut', checked: app.sectionAxis === 'none', run: () => app.setSection('none') },
        { label: '沿 X 轴', icon: 'right', checked: app.sectionAxis === 'x', run: () => app.setSection('x') },
        { label: '沿 Y 轴', icon: 'top', checked: app.sectionAxis === 'y', run: () => app.setSection('y') },
        { label: '沿 Z 轴', icon: 'front', checked: app.sectionAxis === 'z', run: () => app.setSection('z') },
      ],
    },
    { sep: true },
    { label: '整屏显示', icon: 'zoomFit', sc: sc('view.fit'), run: () => app.zoomFit() },
    { label: '上一视图', icon: 'prevView', sc: sc('view.prevView'), run: () => app.prevView() },
    { sep: true },
    { label: '视图设置…', icon: 'viewSettings', run: () => openViewSettings(app) },
    { sep: true },
    { label: '显示模式：透视', icon: 'perspective', checked: app.projection === 'perspective', run: () => app.setProjection('perspective') },
    { label: '显示模式：正投影', icon: 'orthographic', checked: app.projection === 'orthographic', run: () => app.setProjection('orthographic') },
  ];
}

function insertMenu(app: App): PopupItem[] {
  return [
    { label: '草图绘制', icon: 'sketch', run: () => app.startSketch('front') },
    { label: '上视基准面草图', icon: 'originPlane', run: () => app.startSketch('top') },
    { label: '右视基准面草图', icon: 'plane', run: () => app.startSketch('right') },
    { sep: true },
    {
      label: '凸台 / 基体',
      icon: 'extrude',
      submenu: [
        { label: '拉伸凸台…', icon: 'extrude', run: () => D.extrude(app, 'add') },
        { label: '旋转凸台…', icon: 'revolve', run: () => D.revolve(app) },
        { label: '放样凸台…', icon: 'loft', run: () => D.loft(app) },
        { label: '扫描凸台…', icon: 'sweep', run: () => D.sweep(app) },
      ],
    },
    {
      label: '切除',
      icon: 'extrudeCut',
      submenu: [
        { label: '拉伸切除…', icon: 'extrudeCut', run: () => D.extrude(app, 'cut') },
        { label: '异型孔向导…', icon: 'hole', run: () => D.holeWizard(app) },
      ],
    },
    {
      label: '基本体',
      icon: 'box',
      submenu: [
        { label: '长方体…', icon: 'box', run: () => D.primitive(app, 'box') },
        { label: '圆柱…', icon: 'cylinder', run: () => D.primitive(app, 'cylinder') },
        { label: '球…', icon: 'sphere', run: () => D.primitive(app, 'sphere') },
        { label: '圆锥…', icon: 'dome', run: () => D.primitive(app, 'cone') },
        { label: '圆环…', icon: 'torus', run: () => D.primitive(app, 'torus') },
      ],
    },
    {
      label: '参考几何体',
      icon: 'plane',
      submenu: [
        { label: '基准面…', icon: 'plane', run: () => D.referencePlane(app) },
        { label: '基准轴…', icon: 'axis', disabled: true },
      ],
    },
    {
      label: '曲线',
      icon: 'spring',
      submenu: [
        { label: '弹簧…', icon: 'spring', run: () => D.spring(app) },
        { label: '涡状线…', icon: 'spiral', run: () => D.spiral(app) },
      ],
    },
    { sep: true },
    {
      label: '特征',
      icon: 'fillet',
      submenu: [
        { label: '圆角…', icon: 'fillet', run: () => D.fillet(app) },
        { label: '倒角…', icon: 'chamfer', run: () => D.chamfer(app) },
        { label: '抽壳…', icon: 'shell', run: () => D.shell(app) },
        { label: '拔模…', icon: 'draft', run: () => D.draft(app) },
        { label: '筋…', icon: 'rib', run: () => D.rib(app) },
      ],
    },
    {
      label: '阵列 / 镜像',
      icon: 'linearPattern',
      submenu: [
        { label: '线性阵列…', icon: 'linearPattern', run: () => D.linearPattern(app) },
        { label: '圆周阵列…', icon: 'circularPattern', run: () => D.circularPattern(app) },
        { label: '镜像…', icon: 'mirror', run: () => D.mirror(app) },
      ],
    },
    {
      label: '实体编辑',
      icon: 'moveBody',
      submenu: [
        { label: '移动 / 复制实体…', icon: 'moveBody', run: () => D.moveBody(app) },
        { label: '缩放…', icon: 'scale', run: () => D.scale(app) },
        { label: '分割…', icon: 'split', run: () => D.split(app) },
        { label: '组合…', icon: 'combine', run: () => D.combine(app) },
        { label: '删除实体…', icon: 'deleteBody', run: () => D.deleteBody(app) },
      ],
    },
    { sep: true },
    {
      label: '装配体',
      icon: 'assembly',
      submenu: [
        { label: '插入当前零件', icon: 'insertComponent', run: () => D.insertComponent(app) },
        { label: '新建零件', icon: 'newPart', run: () => D.newComponent(app) },
        { label: '配合…', icon: 'mate', run: () => D.mate(app) },
      ],
    },
    {
      label: '工程图视图',
      icon: 'projectedView',
      submenu: [
        { label: '生成三视图', icon: 'projectedView', run: () => D.generateDrawing(app, ['front', 'top', 'right', 'iso']) },
        { label: '主视图', icon: 'front', run: () => D.addDrawingView(app, 'front') },
        { label: '俯视图', icon: 'top', run: () => D.addDrawingView(app, 'top') },
        { label: '右视图', icon: 'right', run: () => D.addDrawingView(app, 'right') },
        { label: '等轴测视图', icon: 'isometric', run: () => D.addDrawingView(app, 'iso') },
      ],
    },
  ];
}

function toolsMenu(app: App): PopupItem[] {
  return [
    { label: '参数表…', icon: 'smartDim', run: () => D.parameterTable(app) },
    { label: '表达式…', icon: 'relation', disabled: !app.doc.features.length, run: () => D.featureExpression(app) },
    { sep: true },
    { label: '测量…', icon: 'measure', run: () => openMeasure(app) },
    { label: '质量属性…', icon: 'massProps', disabled: !app.hasModel, run: () => void app.showMassProperties() },
    { label: '模型统计…', icon: 'info', run: () => D.modelInfo(app) },
    { label: '几何检查…', icon: 'check', run: () => D.geometryCheck(app) },
    { sep: true },
    {
      label: '单位制',
      icon: 'dimension',
      submenu: UNIT_SYSTEMS.map((u) => ({
        label: u.label,
        tip: u.label === 'MMGS' ? '公制（毫米）' : u.label === 'CGS' ? '厘米-克-秒' : '英制（英寸）',
        checked: app.unitSystem === u.id,
        run: () => app.setUnitSystem(u.id),
      })),
    },
    { sep: true },
    {
      label: '草图工具',
      icon: 'sketch',
      submenu: [
        { label: '智能尺寸', icon: 'smartDim', run: () => D.smartDimension(app) },
        { label: '添加几何关系', icon: 'addRelation2', run: () => D.addRelation(app, 'coincident') },
        { label: '构造几何线', icon: 'construction', run: () => D.toggleConstruction(app) },
        { label: '镜像实体', icon: 'mirrorEntities', run: () => D.mirrorEntities(app) },
      ],
    },
    {
      label: '草图设定',
      icon: 'settings',
      submenu: [
        { label: '显示网格', icon: 'grid', checked: app.showGrid, run: () => app.toggleGrid(!app.showGrid) },
        { label: '显示基准面', icon: 'plane', checked: app.showPlanes, run: () => app.togglePlanes(!app.showPlanes) },
        { label: '显示原点', icon: 'origin', checked: app.showOrigin, run: () => app.toggleOrigin(!app.showOrigin) },
      ],
    },
    { sep: true },
    { label: 'AI 建模助手…', icon: 'ai', run: () => openAiModeling(app, { mode: 'create' }) },
    { label: 'AI 语法帮助…', icon: 'aiPrompt', run: () => openAiHelp() },
    { sep: true },
    { label: '宏…', icon: 'macro', disabled: true },
    { label: '插件…', icon: 'options', disabled: true },
    { sep: true },
    { label: '视图设置…', icon: 'viewSettings', run: () => openViewSettings(app) },
    { label: '快捷键一览…', icon: 'help', run: () => showHotkeyHelp(app) },
  ];
}

function windowMenu(app: App): PopupItem[] {
  return [
    { label: '零件', icon: 'part', checked: app.mode === 'model', run: () => app.setMode('model') },
    { label: '装配体', icon: 'assembly', checked: app.mode === 'assembly', run: () => app.setMode('assembly') },
    { label: '工程图', icon: 'drawing', checked: app.mode === 'drawing', run: () => app.setMode('drawing') },
    { sep: true },
    { label: '切换文档', icon: 'window', sc: sc('window.cycle'), run: () => app.cycleDocument() },
    { label: '关闭文档', icon: 'closeDoc', run: () => app.newProject() },
    { sep: true },
    { label: '新建窗口', icon: 'window', disabled: true },
    { label: '层叠', icon: 'window', disabled: true },
    { label: '横向平铺', icon: 'window', disabled: true },
    { label: '纵向平铺', icon: 'window', disabled: true },
  ];
}

function helpMenu(app: App): PopupItem[] {
  return [
    { label: '快捷键一览…', icon: 'help', run: () => showHotkeyHelp(app) },
    { label: 'AI 语法帮助…', icon: 'aiPrompt', run: () => openAiHelp() },
    { label: '鼠标操作说明…', icon: 'pan', run: () => showMouseHelp() },
    { sep: true },
    { label: 'Solid2 帮助主题', icon: 'book', disabled: true },
    { label: '教程…', icon: 'book', disabled: true },
    { sep: true },
    { label: '关于 Solid2…', icon: 'about', run: () => showAbout() },
  ];
}

// ============================================================
// 辅助
// ============================================================
function showHotkeyHelp(app: App): void {
  void app;
  const groups = hotkeyGroups();
  const body = el('div', { class: 'hk-help' });
  for (const g of groups) {
    const sec = el('div', { class: 'hk-sec' }, el('div', { class: 'hk-sec-title', text: g.group }));
    const table = el('table', { class: 'hk-table' });
    for (const it of g.items) {
      table.appendChild(
        el('tr', {}, el('td', { class: 'hk-key', text: it.keys }), el('td', { text: it.label }))
      );
    }
    sec.appendChild(table);
    body.appendChild(sec);
  }
  body.appendChild(
    el('div', { class: 'hint', text: '鼠标：中键拖动旋转 · Ctrl+中键拖动平移 · Shift+中键拖动缩放 · 滚轮缩放 · 右键拖动鼠标手势 · 右键单击上下文菜单 · 左键选择' })
  );
  modal({ title: '快捷键一览', body, actions: [{ label: '关闭', primary: true }], width: 620 });
}

function showMouseHelp(): void {
  tableModal(
    '鼠标操作说明',
    ['操作', '功能'],
    [
      ['中键拖动', '旋转视图'],
      ['Ctrl + 中键拖动', '平移视图'],
      ['Shift + 中键拖动', '缩放视图'],
      ['滚轮', '缩放视图'],
      ['左键单击', '选择面 / 边'],
      ['Ctrl / Shift + 左键', '加选 / 减选'],
      ['右键单击', '上下文菜单（快捷方式栏 + 命令）'],
      ['右键拖动', '鼠标手势（4 方向）'],
      ['按 S', '快捷方式栏'],
      ['按空格', '视图定向'],
      ['按 G', '放大镜'],
      ['按 F', '整屏显示'],
    ],
    '与 SolidWorks 默认鼠标映射一致。'
  );
}

function showAbout(): void {
  const body = el(
    'div',
    { class: 'col about-body' },
    el('div', { class: 'about-logo' }, 'Solid', el('b', { text: '2' })),
    el('div', { class: 'about-sub', text: '参数化三维 CAD · OpenCASCADE 几何内核' }),
    el('div', { class: 'hint', text: '界面按 SolidWorks 布局复刻：七菜单 + CommandManager + Heads-up 视图工具栏 + 特征管理器设计树 + 确认角 + 参考三重轴，热键与鼠标映射沿用 SolidWorks 默认设置。' }),
    el('div', { class: 'hint', text: '几何内核：OpenCASCADE（WebAssembly）· 渲染：three.js · 内核运行在 Web Worker 中，主线程不引用 OCCT。' })
  );
  modal({ title: '关于 Solid2', body, actions: [{ label: '确定', primary: true }], width: 480 });
}

/** 命令搜索：在 CommandManager 的全部命令里模糊匹配并执行 */
function searchCommand(query: string): (() => void) | null {
  if (!query) return null;
  const ctrl = ribbonController();
  if (!ctrl) return null;
  const hit = ctrl.findCommand(query);
  if (!hit) return null;
  return () => ctrl.runCommand(hit);
}
