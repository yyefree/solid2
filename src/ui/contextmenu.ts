/**
 * SolidWorks 右键上下文菜单。
 *
 * 结构：顶部一条 4 个图标的「快捷方式栏」+ 下方命令列表（可带子菜单）。
 * 菜单内容随上下文变化：图形区空白 / 选中面 / 选中边 / 设计树上的特征 / 设计树空白。
 */
import type { AppApi } from '../app/app-api';
import { openContextMenu, type PopupItem } from './popup';
import { featureDialogs } from './dialogs';
import { openMeasure } from './measure';
import { notify, confirmDialog, promptText } from './toast';
import { sc } from '../app/hotkeys';
import { FEATURE_LABEL } from '../doc/types';
import { openViewSettings } from './headsup';

const D = featureDialogs;

/** 图形区右键 */
export function installContextMenu(app: AppApi, host: HTMLElement): () => void {
  const onCtx = (e: MouseEvent) => {
    e.preventDefault();
    const faces = app.selection.faces.length;
    const edges = app.selection.edges.length;
    if (app.mode === 'sketch') {
      openContextMenu(
        [
          { icon: 'smartDim', label: '智能尺寸', run: () => D.smartDimension(app) },
          { icon: 'trim', label: '剪裁实体', run: () => D.deleteSketchSelection(app) },
          { icon: 'mirrorEntities', label: '镜像实体', run: () => D.mirrorEntities(app) },
          { icon: 'exitSketch', label: '退出草图', run: () => app.exitSketch(false) },
        ],
        sketchItems(app),
        e.clientX,
        e.clientY
      );
      return;
    }
    if (faces) {
      openContextMenu(
        [
          { icon: 'sketch', label: '在面上绘制草图', run: () => D.sketchOnFace(app) },
          { icon: 'fillet', label: '圆角', run: () => D.fillet(app) },
          { icon: 'chamfer', label: '倒角', run: () => D.chamfer(app) },
          { icon: 'measure', label: '测量', run: () => openMeasure(app) },
        ],
        faceItems(app, e.clientX, e.clientY),
        e.clientX,
        e.clientY
      );
      return;
    }
    if (edges) {
      openContextMenu(
        [
          { icon: 'fillet', label: '圆角', run: () => D.fillet(app) },
          { icon: 'chamfer', label: '倒角', run: () => D.chamfer(app) },
          { icon: 'measure', label: '测量', run: () => openMeasure(app) },
          { icon: 'sketch', label: '在面上绘制草图', run: () => D.sketchOnFace(app) },
        ],
        edgeItems(app),
        e.clientX,
        e.clientY
      );
      return;
    }
    openContextMenu(
      [
        { icon: 'viewOrient', label: '视图定向', run: () => app.setView('iso') },
        { icon: 'displayStyle2', label: '显示样式', run: () => app.setDisplayStyle('shadedEdges') },
        { icon: 'sectionCut', label: '剖面视图', run: () => app.toggleSection('x') },
        { icon: 'zoomFit', label: '整屏显示', run: () => app.zoomFit() },
      ],
      blankItems(app),
      e.clientX,
      e.clientY
    );
  };
  host.addEventListener('contextmenu', onCtx);
  return () => host.removeEventListener('contextmenu', onCtx);
}

function viewItems(app: AppApi): PopupItem[] {
  return [
    { label: '前视', icon: 'front', sc: sc('view.front'), run: () => app.setView('front') },
    { label: '后视', icon: 'front', sc: sc('view.back'), run: () => app.setView('back') },
    { label: '左视', icon: 'left', sc: sc('view.left'), run: () => app.setView('left') },
    { label: '右视', icon: 'right', sc: sc('view.right'), run: () => app.setView('right') },
    { label: '俯视', icon: 'top', sc: sc('view.top'), run: () => app.setView('top') },
    { label: '仰视', icon: 'top', sc: sc('view.bottom'), run: () => app.setView('bottom') },
    { label: '等轴测', icon: 'isometric', sc: sc('view.iso'), run: () => app.setView('iso') },
  ];
}

function displayStyleItems(app: AppApi): PopupItem[] {
  const mk = (label: string, ic: string, style: string): PopupItem => ({
    label,
    icon: ic,
    checked: app.displayStyle === style,
    run: () => app.setDisplayStyle(style as never),
  });
  return [
    mk('带边线上色', 'shaded', 'shadedEdges'),
    mk('上色', 'realview', 'shaded'),
    mk('消除隐藏线', 'hiddenLines', 'hidden'),
    mk('线架图', 'wireframe', 'wireframe'),
    mk('透明', 'transparency', 'transparent'),
  ];
}

function hideShowItems(app: AppApi): PopupItem[] {
  return [
    { label: '基准面', icon: 'plane', checked: app.showPlanes, run: () => app.togglePlanes(!app.showPlanes) },
    { label: '网格', icon: 'grid', checked: app.showGrid, run: () => app.toggleGrid(!app.showGrid) },
    { label: '原点', icon: 'origin', checked: app.showOrigin, run: () => app.toggleOrigin(!app.showOrigin) },
  ];
}

function sceneItems(app: AppApi): PopupItem[] {
  return (['默认', '单色灰', '深色', '白色'] as const).map((n) => ({
    label: n,
    icon: 'applyScene',
    checked: app.sceneName === n,
    run: () => app.setScene(n),
  }));
}

function moreCommandsItems(app: AppApi): PopupItem[] {
  return [
    { label: '快捷键一览…', icon: 'help', run: () => window.dispatchEvent(new CustomEvent('solid2:help')) },
    { label: '视图设置…', icon: 'viewSettings', run: () => openViewSettings(app) },
    { sep: true },
    { label: '自定义…', icon: 'options', disabled: true },
    { label: '关于 Solid2…', icon: 'about', run: () => notify.info('Solid2 — Web 参数化三维 CAD') },
  ];
}

function blankItems(app: AppApi): PopupItem[] {
  return [
    { label: '缩放至区域…', icon: 'zoomArea', run: () => notify.info('请用顶部视图工具栏的「缩放至区域」按钮') },
    { label: '上一视图', icon: 'prevView', sc: sc('view.prevView'), run: () => app.prevView() },
    { sep: true },
    { label: '视图定向', icon: 'viewOrient', submenu: viewItems(app) },
    { label: '显示样式', icon: 'displayStyle2', submenu: displayStyleItems(app) },
    { label: '隐藏 / 显示项目', icon: 'hideShowItems', submenu: hideShowItems(app) },
    { label: '应用布景', icon: 'applyScene', submenu: sceneItems(app) },
    { sep: true },
    {
      label: '参考几何体',
      icon: 'plane',
      submenu: [
        { label: '基准面…', icon: 'plane', run: () => D.referencePlane(app) },
        { label: '基准轴…', icon: 'axis', disabled: true },
      ],
    },
    { label: '草图绘制', icon: 'sketch', run: () => app.startSketch('front') },
    { sep: true },
    { label: '重建模型', icon: 'rebuild', sc: sc('view.rebuild'), run: () => app.rebuildModel() },
    { label: '属性…', icon: 'info', sc: sc('edit.properties'), run: () => app.showProperties() },
    { sep: true },
    { label: '更多命令…', icon: 'help', submenu: moreCommandsItems(app) },
  ];
}

/**
 * 「选择其他…」子菜单：列出该屏幕位置射线穿过的所有候选面（SolidWorks 同名功能）。
 * 只有候选 ≥ 1（即确实有其它面可重选）时才出现。
 */
function selectOtherItems(app: AppApi, x: number, y: number): PopupItem[] {
  const cands = app.pickCandidateFaces(x, y);
  const cur = app.selection.faces;
  return [
    { label: `选择其他…（${cands.length} 个候选）`, icon: 'check', disabled: true },
    { sep: true },
    ...cands.map((fi): PopupItem => {
      const meta = app.shapeView?.faceMetas[fi];
      const area = meta ? ` ${meta.area.toFixed(1)} mm²` : '';
      return {
        label: `面 ${fi + 1}${area}`,
        icon: 'plane',
        radio: true,
        checked: cur.includes(fi),
        run: () => app.selectFace(fi),
      };
    }),
  ];
}

function faceItems(app: AppApi, x: number, y: number): PopupItem[] {
  const n = app.selection.faces.length;
  const others = app.pickCandidateFaces(x, y).length;
  return [
    { label: `已选中 ${n} 个面`, icon: 'check', disabled: true },
    ...(others > 1 ? ([{ label: '选择其他…', icon: 'plane', submenu: selectOtherItems(app, x, y) }] as PopupItem[]) : []),
    { sep: true },
    { label: '在面上绘制草图', icon: 'sketch', run: () => D.sketchOnFace(app) },
    { label: '异型孔向导…', icon: 'hole', run: () => D.holeWizard(app) },
    { label: '圆角…', icon: 'fillet', run: () => D.fillet(app) },
    { label: '倒角…', icon: 'chamfer', run: () => D.chamfer(app) },
    { label: '抽壳…', icon: 'shell', run: () => D.shell(app) },
    { label: '拔模…', icon: 'draft', run: () => D.draft(app) },
    { sep: true },
    { label: '测量…', icon: 'measure', run: () => openMeasure(app) },
    { label: '质量属性…', icon: 'massProps', run: () => app.showMassProperties() },
    { sep: true },
    { label: '清除选择', icon: 'x', sc: 'Esc', run: () => app.clearSelection() },
    { sep: true },
    { label: '更多命令…', icon: 'help', submenu: moreCommandsItems(app) },
  ];
}

function edgeItems(app: AppApi): PopupItem[] {
  const n = app.selection.edges.length;
  return [
    { label: `已选中 ${n} 条边`, icon: 'check', disabled: true },
    { sep: true },
    { label: '圆角…', icon: 'fillet', run: () => D.fillet(app) },
    { label: '倒角…', icon: 'chamfer', run: () => D.chamfer(app) },
    { label: '筋…', icon: 'rib', run: () => D.rib(app) },
    { sep: true },
    { label: '测量…', icon: 'measure', run: () => openMeasure(app) },
    { sep: true },
    { label: '清除选择', icon: 'x', sc: 'Esc', run: () => app.clearSelection() },
    { sep: true },
    { label: '更多命令…', icon: 'help', submenu: moreCommandsItems(app) },
  ];
}

function sketchItems(app: AppApi): PopupItem[] {
  return [
    { label: '智能尺寸', icon: 'smartDim', sc: sc('sk.dim'), run: () => D.smartDimension(app) },
    { label: '构造几何线', icon: 'construction', run: () => D.toggleConstruction(app) },
    { label: '镜像实体', icon: 'mirrorEntities', run: () => D.mirrorEntities(app) },
    { sep: true },
    {
      label: '添加几何关系',
      icon: 'relation',
      submenu: [
        { label: '水平', icon: 'relation', run: () => D.addRelation(app, 'horizontal') },
        { label: '竖直', icon: 'relation', run: () => D.addRelation(app, 'vertical') },
        { label: '重合', icon: 'addRelation', run: () => D.addRelation(app, 'coincident') },
        { label: '平行', icon: 'relation', run: () => D.addRelation(app, 'parallel') },
        { label: '垂直', icon: 'relation', run: () => D.addRelation(app, 'perpendicular') },
        { label: '相等', icon: 'relation', run: () => D.addRelation(app, 'equal') },
        { label: '相切', icon: 'relation', run: () => D.addRelation(app, 'tangent') },
        { label: '同心', icon: 'relation', run: () => D.addRelation(app, 'concentric') },
      ],
    },
    { sep: true },
    { label: '剪裁实体', icon: 'trim', sc: sc('sk.trim'), run: () => D.deleteSketchSelection(app) },
    { label: '全选', icon: 'check', sc: sc('edit.selectAll'), run: () => app.selectAll() },
    { sep: true },
    { label: '退出草图', icon: 'exitSketch', sc: 'Esc', run: () => app.exitSketch(false) },
    { sep: true },
    { label: '更多命令…', icon: 'help', submenu: moreCommandsItems(app) },
  ];
}

// ============================================================
// 设计树右键
// ============================================================
export function openFeatureContextMenu(app: AppApi, id: string, x: number, y: number): void {
  const f = app.doc.getFeature(id);
  if (!f) return;
  const isSketch = f.type === 'sketch';
  const suppressed = !!f.suppressed;

  const toggleSuppress = () => {
    const feat = app.doc.getFeature(id);
    if (!feat) return;
    feat.suppressed = !feat.suppressed;
    app.rebuild();
    notify.ok(feat.suppressed ? `已压缩 ${feat.name}` : `已解除压缩 ${feat.name}`);
  };

  openContextMenu(
    [
      { icon: isSketch ? 'sketch' : 'rebuild', label: isSketch ? '编辑草图' : '编辑特征', run: () => editFeature(app, id) },
      { icon: suppressed ? 'unsuppress' : 'suppress', label: suppressed ? '解除压缩' : '压缩', run: toggleSuppress },
      { icon: 'rename', label: '重命名', run: () => renameFeature(app, id) },
      { icon: 'trash', label: '删除', run: () => confirmDialog('删除特征', `确定删除「${f.name}」？`, () => app.removeFeature(id)) },
    ],
    [
      { label: `特征：${f.name}`, icon: isSketch ? 'sketch' : 'rebuild', disabled: true },
      { label: `类型：${FEATURE_LABEL[f.type] ?? f.type}`, icon: 'info', disabled: true },
      { sep: true },
      { label: '编辑草图', icon: 'sketch', run: () => editFeature(app, id), disabled: !isSketch },
      { label: '编辑特征…', icon: 'rebuild', run: () => editFeature(app, id) },
      { sep: true },
      { label: suppressed ? '解除压缩' : '压缩', icon: suppressed ? 'unsuppress' : 'suppress', run: toggleSuppress },
      { label: '隐藏 / 显示', icon: 'hideShow', disabled: true },
      { label: '重命名', icon: 'rename', run: () => renameFeature(app, id) },
      { label: '父子关系…', icon: 'parents', disabled: true },
      { sep: true },
      { label: '上移', icon: 'rollback', run: () => { app.doc.move(id, -1); app.rebuild(); } },
      { label: '下移', icon: 'rollback', run: () => { app.doc.move(id, 1); app.rebuild(); } },
      { label: '回退到此处', icon: 'rollback', disabled: true },
      { sep: true },
      {
        label: '删除',
        icon: 'trash',
        sc: 'Delete',
        run: () => confirmDialog('删除特征', `确定删除「${f.name}」？`, () => app.removeFeature(id)),
      },
    ],
    x,
    y
  );
}

export function openTreeContextMenu(app: AppApi, x: number, y: number): void {
  openContextMenu(
    [
      { icon: 'sketch', label: '草图绘制', run: () => app.startSketch('front') },
      { icon: 'extrude', label: '拉伸凸台', run: () => D.extrude(app, 'add') },
      { icon: 'fillet', label: '圆角', run: () => D.fillet(app) },
      { icon: 'plane', label: '基准面', run: () => D.referencePlane(app) },
    ],
    [
      { label: '草图绘制', icon: 'sketch', run: () => app.startSketch('front') },
      { label: '上视基准面草图', icon: 'originPlane', run: () => app.startSketch('top') },
      { label: '右视基准面草图', icon: 'plane', run: () => app.startSketch('right') },
      { sep: true },
      {
        label: '插入',
        icon: 'extrude',
        submenu: [
          { label: '拉伸凸台…', icon: 'extrude', run: () => D.extrude(app, 'add') },
          { label: '拉伸切除…', icon: 'extrudeCut', run: () => D.extrude(app, 'cut') },
          { label: '旋转…', icon: 'revolve', run: () => D.revolve(app) },
          { label: '放样…', icon: 'loft', run: () => D.loft(app) },
          { label: '扫描…', icon: 'sweep', run: () => D.sweep(app) },
          { label: '异型孔向导…', icon: 'hole', run: () => D.holeWizard(app) },
          { label: '圆角…', icon: 'fillet', run: () => D.fillet(app) },
          { label: '倒角…', icon: 'chamfer', run: () => D.chamfer(app) },
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
      { sep: true },
      { label: '参数表…', icon: 'smartDim', run: () => D.parameterTable(app) },
      { label: '质量属性…', icon: 'massProps', run: () => app.showMassProperties() },
      { sep: true },
      { label: '展开所有', icon: 'caretDown', run: () => document.querySelectorAll('.tnode.collapsed').forEach((n) => n.classList.remove('collapsed')) },
    ],
    x,
    y
  );
}

function editFeature(app: AppApi, id: string): void {
  const f = app.doc.getFeature(id);
  if (!f) return;
  if (f.type === 'sketch' && app.mode !== 'sketch') {
    app.enterSketch(f as never);
    return;
  }  app.emit('props');
  notify.info(`已选中「${f.name}」，可在左侧属性管理器修改参数`);
}

function renameFeature(app: AppApi, id: string): void {
  const f = app.doc.getFeature(id);
  if (!f) return;
  promptText('重命名特征', '名称', f.name, (v) => {
    f.name = v;
    app.emit('tree', 'props');
    notify.ok(`已重命名为「${v}」`);
  });
}
