/**
 * SolidWorks 快捷方式栏（S 键）与鼠标手势（右键拖动）。
 *
 * - 按 S：在光标处弹出 4 / 8 个最常用命令，点一下就执行（按 Esc / 点空白关闭）。
 * - 右键拖动：弹出 4 / 8 方向手势轮盘，松手时落在哪个方向就执行哪个命令。
 *   与 SolidWorks 一致：右键**单击**仍是上下文菜单，只有拖动超过阈值才算手势。
 */
import { el, clear } from './dom';
import { icon } from './icons';
import type { App } from '../app/app';
import { featureDialogs } from './dialogs';
import { openMeasure } from './measure';
import { notify } from './toast';

interface BarCmd {
  icon: string;
  label: string;
  run: (app: App) => void;
}

/** 每个模式下的快捷方式栏命令（前 4 个为默认 4 方向） */
function commandsFor(app: App): BarCmd[] {
  const D = featureDialogs;
  if (app.mode === 'sketch') {
    return [
      { icon: 'smartDim', label: '智能尺寸', run: (a) => D.smartDimension(a) },
      { icon: 'trim', label: '剪裁实体', run: (a) => D.deleteSketchSelection(a) },
      { icon: 'mirrorEntities', label: '镜像实体', run: (a) => D.mirrorEntities(a) },
      { icon: 'exitSketch', label: '退出草图', run: (a) => a.exitSketch(false) },
      { icon: 'construction', label: '构造几何线', run: (a) => D.toggleConstruction(a) },
      { icon: 'relation', label: '添加几何关系', run: (a) => D.addRelation(a, 'coincident') },
      { icon: 'rectangle', label: '矩形', run: (a) => a.setSketchTool('rect') },
      { icon: 'circle', label: '圆', run: (a) => a.setSketchTool('circle') },
    ];
  }
  if (app.mode === 'assembly') {
    return [
      { icon: 'mate', label: '配合', run: (a) => D.mate(a) },
      { icon: 'moveComponent', label: '移动零部件', run: (a) => D.insertComponent(a) },
      { icon: 'interference', label: '干涉检查', run: (a) => D.interference(a) },
      { icon: 'explode', label: '爆炸视图', run: (a) => D.explodeDialog(a) },
      { icon: 'fixComponent', label: '固定 / 浮动', run: (a) => D.toggleFixed(a) },
      { icon: 'rebuild', label: '重新求解', run: (a) => D.solveAssembly(a) },
      { icon: 'insertComponent', label: '插入零件', run: (a) => D.insertComponent(a) },
      { icon: 'massProps', label: '质量属性', run: (a) => a.showMassProperties() },
    ];
  }
  if (app.mode === 'drawing') {
    return [
      { icon: 'projectedView', label: '模型视图', run: (a) => D.addDrawingView(a, 'front') },
      { icon: 'dimension', label: '尺寸标注', run: (a) => D.drawingDimension(a) },
      { icon: 'smartDim', label: '自动标注', run: (a) => D.autoDimensionDrawing(a) },
      { icon: 'bom', label: '明细表', run: (a) => D.toggleBOM(a) },
      { icon: 'sectionView', label: '剖面视图', run: (a) => D.addDrawingView(a, 'right') },
      { icon: 'annotation', label: '孔位标注', run: (a) => D.autoHoleDimension(a) },
      { icon: 'export', label: '导出 SVG', run: (a) => D.exportDrawingSVG(a) },
      { icon: 'sheetFormat', label: '图纸属性', run: (a) => D.sheetSettings(a) },
    ];
  }
  // 零件
  return [
    { icon: 'sketch', label: '草图绘制', run: (a) => a.startSketch('front') },
    { icon: 'extrude', label: '拉伸凸台', run: (a) => D.extrude(a, 'add') },
    { icon: 'fillet', label: '圆角', run: (a) => D.fillet(a) },
    { icon: 'measure', label: '测量', run: (a) => openMeasure(a) },
    { icon: 'extrudeCut', label: '拉伸切除', run: (a) => D.extrude(a, 'cut') },
    { icon: 'hole', label: '异型孔向导', run: (a) => D.holeWizard(a) },
    { icon: 'mirror', label: '镜像', run: (a) => D.mirror(a) },
    { icon: 'massProps', label: '质量属性', run: (a) => a.showMassProperties() },
  ];
}

/** 鼠标手势：4 方向（SolidWorks 默认） */
function gestureCommandsFor(app: App): BarCmd[] {
  const D = featureDialogs;
  if (app.mode === 'sketch') {
    return [
      { icon: 'smartDim', label: '智能尺寸', run: (a) => D.smartDimension(a) },
      { icon: 'trim', label: '剪裁实体', run: (a) => D.deleteSketchSelection(a) },
      { icon: 'exitSketch', label: '退出草图', run: (a) => a.exitSketch(false) },
      { icon: 'mirrorEntities', label: '镜像实体', run: (a) => D.mirrorEntities(a) },
      { icon: 'line', label: '直线', run: (a) => a.setSketchTool('line') },
      { icon: 'rectangle', label: '矩形', run: (a) => a.setSketchTool('rect') },
      { icon: 'circle', label: '圆', run: (a) => a.setSketchTool('circle') },
      { icon: 'relation', label: '几何关系', run: (a) => D.addRelation(a, 'coincident') },
    ];
  }
  return [
    { icon: 'viewOrient', label: '视图定向', run: (a) => a.setView('iso') },
    { icon: 'prevView', label: '上一视图', run: (a) => a.prevView() },
    { icon: 'zoomFit', label: '整屏显示', run: (a) => a.zoomFit() },
    { icon: 'sectionCut', label: '剖面视图', run: (a) => a.toggleSection('x') },
    { icon: 'isometric', label: '等轴测', run: (a) => a.setView('iso') },
    { icon: 'front', label: '前视', run: (a) => a.setView('front') },
    { icon: 'top', label: '俯视', run: (a) => a.setView('top') },
    { icon: 'right', label: '右视', run: (a) => a.setView('right') },
  ];
}

// ============================================================
// 快捷方式栏（S）
// ============================================================
let bar: HTMLElement | null = null;
let barCount = 4;
let lastPointer = { x: 200, y: 200 };

export function openShortcutBar(app: App, at?: { x: number; y: number }): void {
  closeShortcutBar();
  const pos = at ?? lastPointer;
  const cmds = commandsFor(app);

  const body = el('div', { class: 'sbar-grid' });
  const paint = () => {
    clear(body);
    const list = cmds.slice(0, barCount);
    for (const c of list) {
      const b = el(
        'button',
        {
          class: 'sbar-btn',
          type: 'button',
          title: c.label,
          onClick: () => {
            closeShortcutBar();
            c.run(app);
          },
        },
        el('span', { class: 'ic', html: icon(c.icon, 22) })
      );
      body.appendChild(b);
    }
  };
  paint();

  const toggle = el('button', {
    class: 'sbar-count',
    type: 'button',
    title: '在 4 个 / 8 个命令之间切换',
    text: barCount === 4 ? '4' : '8',
    onClick: () => {
      barCount = barCount === 4 ? 8 : 4;
      toggle.textContent = barCount === 4 ? '4' : '8';
      paint();
    },
  });

  const box = el('div', { class: 'sbar' }, body, toggle);
  const w = barCount === 4 ? 4 * 42 + 30 : 8 * 42 + 30;
  const h = 58;
  box.style.left = `${Math.min(Math.max(pos.x - w / 2, 8), window.innerWidth - w - 8)}px`;
  box.style.top = `${Math.min(Math.max(pos.y + 14, 8), window.innerHeight - h - 8)}px`;
  document.body.appendChild(box);
  bar = box;
  app.setStatus(`快捷方式栏：${barCount} 个常用命令（S 关闭 / 点右下角切换 4·8）`, 'busy');

  setTimeout(() => {
    const away = (e: MouseEvent) => {
      if (!bar) return;
      if (bar.contains(e.target as Node)) return;
      closeShortcutBar();
      document.removeEventListener('mousedown', away, true);
    };
    document.addEventListener('mousedown', away, true);
  }, 10);
}

export function closeShortcutBar(): void {
  bar?.remove();
  bar = null;
}

export function shortcutBarOpen(): boolean {
  return !!bar;
}

// ============================================================
// 鼠标手势
// ============================================================
const GESTURE_THRESHOLD = 22;
const DIRS8: { name: string; dx: number; dy: number; deg: number }[] = [
  { name: 'up', dx: 0, dy: -1, deg: -90 },
  { name: 'right', dx: 1, dy: 0, deg: 0 },
  { name: 'down', dx: 0, dy: 1, deg: 90 },
  { name: 'left', dx: -1, dy: 0, deg: 180 },
  { name: 'upRight', dx: 1, dy: -1, deg: -45 },
  { name: 'downRight', dx: 1, dy: 1, deg: 45 },
  { name: 'downLeft', dx: -1, dy: 1, deg: 135 },
  { name: 'upLeft', dx: -1, dy: -1, deg: -135 },
];

interface Wheel {
  el: HTMLElement;
  sectors: HTMLElement[];
  count: number;
}
let wheel: Wheel | null = null;
let gestureConsumed = false;

/** 手势是否刚刚被消费（用于抑制紧随其后的 contextmenu） */
export function gestureJustFired(): boolean {
  return gestureConsumed;
}

export function installMouseGestures(app: App, host: HTMLElement): () => void {
  const canvas = app.viewport.renderer.domElement;
  let dragging = false;
  let start = { x: 0, y: 0 };
  let active = -1;
  let sectors: HTMLElement[] = [];

  const onDown = (e: PointerEvent) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (e.button !== 2) return;
    dragging = true;
    gestureConsumed = false;
    start = { x: e.clientX, y: e.clientY };
    active = -1;
  };

  const onMove = (e: PointerEvent) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (!dragging) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!wheel) {
      if (Math.hypot(dx, dy) < GESTURE_THRESHOLD) return;
      wheel = buildWheel(app);
      document.body.appendChild(wheel.el);
      wheel.el.style.left = `${start.x}px`;
      wheel.el.style.top = `${start.y}px`;
      sectors = wheel.sectors;
    }
    // 判定方向：找与拖动方向夹角最小的那个扇区
    const n = wheel.count;
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < n; i++) {
      let diff = Math.abs(ang - DIRS8[i].deg);
      if (diff > 180) diff = 360 - diff;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    if (Math.hypot(dx, dy) >= GESTURE_THRESHOLD && best !== active) {
      active = best;
      sectors.forEach((s, i) => s.classList.toggle('on', i === active));
    }
  };

  const onUp = (e: PointerEvent) => {
    if (e.button !== 2 || !dragging) return;
    dragging = false;
    const cmds = gestureCommandsFor(app);
    if (wheel && active >= 0 && cmds[active]) {
      gestureConsumed = true;
      const cmd = cmds[active];
      closeWheel();
      notify.info(`鼠标手势：${cmd.label}`);
      cmd.run(app);
      // 抑制随后的 contextmenu
      setTimeout(() => (gestureConsumed = false), 400);
      return;
    }
    closeWheel();
  };

  const closeWheel = () => {
    wheel?.el.remove();
    wheel = null;
    sectors = [];
    active = -1;
  };

  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerup', onUp);
  // 防止手势拖动过程中弹出浏览器菜单
  const onCtx = (e: MouseEvent) => {
    if (wheel) {
      e.preventDefault();
      return;
    }
  };
  host.addEventListener('contextmenu', onCtx);

  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    host.removeEventListener('contextmenu', onCtx);
    closeWheel();
  };
}

function buildWheel(app: App): { el: HTMLElement; sectors: HTMLElement[]; count: number } {
  const count = 4; // SolidWorks 默认 4 方向；可在设置中改 8
  const cmds = gestureCommandsFor(app);
  const R = 74;
  const root = el('div', { class: 'gesture-wheel' });
  const hub = el('div', { class: 'gw-hub' }, el('span', { class: 'ic', html: icon('pan', 18) }));
  root.appendChild(hub);
  const sectors: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    const d = DIRS8[i];
    const s = el('div', { class: 'gw-sec' }, el('span', { class: 'ic', html: icon(cmds[i].icon, 20) }));
    s.style.left = `${Math.cos((d.deg * Math.PI) / 180) * R}px`;
    s.style.top = `${Math.sin((d.deg * Math.PI) / 180) * R}px`;
    s.title = cmds[i].label;
    root.appendChild(s);
    sectors.push(s);
  }
  return { el: root, sectors, count };
}
