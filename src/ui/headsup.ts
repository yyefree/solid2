/**
 * SolidWorks Heads-up 视图工具栏（图形区顶部居中）。
 *
 * 从左到右与 SolidWorks 一致：
 *   视图定向 · 显示样式 · 隐藏/显示项目 · 应用布景 · 剖面视图 · 整屏显示 ·
 *   缩放至区域 · 放大 · 缩小 · 上一视图 · 旋转视图 · 编辑外观 · 光源 ·
 *   视图设置 · 显示模式
 */
import { el } from './dom';
import { icon } from './icons';
import * as THREE from 'three';
import type { App } from '../app/app';
import { openPopup, type PopupItem } from './popup';
import { notify, modal } from './toast';
import { featureDialogs } from './dialogs';
import { sc } from '../app/hotkeys';
import { LIGHT_PRESET_NAMES, type LightPresetName } from '../view/viewport';

/** 外观色板（Heads-up「编辑外观」）—— 常用工业配色 */
const APPEARANCE_COLORS: { label: string; hex: number }[] = [
  { label: '默认灰', hex: 0xc8d0d8 },
  { label: '红色', hex: 0xd9432f },
  { label: '蓝色', hex: 0x2b7de9 },
  { label: '绿色', hex: 0x3f9d4e },
  { label: '黄色', hex: 0xe8b93a },
  { label: '橙色', hex: 0xe07b2a },
  { label: '紫色', hex: 0x8a5cf6 },
  { label: '白色', hex: 0xf2f4f6 },
  { label: '黑色', hex: 0x2b3542 },
];

export function buildHeadsUp(app: App, host: HTMLElement): void {
  const bar = el('div', { class: 'headsup' });

  const btn = (id: string, label: string, ic: string, onClick: (e: MouseEvent) => void, extra = '') => {
    const shortcut = sc(id);
    const tip = shortcut && shortcut !== '—' ? `${label} (${shortcut})` : label;
    return el(
      'button',
      {
        class: `hu-btn ${extra}`.trim(),
        type: 'button',
        title: tip,
        dataset: { cmd: id },
        onClick: (e: MouseEvent) => onClick(e),
      },
      el('span', { class: 'ic', html: icon(ic, 18) })
    );
  };

  const dropdown = (id: string, label: string, ic: string, items: () => PopupItem[]) =>
    btn(id, label, ic, (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      openPopup(items(), r.left, r.bottom + 2, { cls: 'hu-menu' });
    });

  // SolidWorks Heads-up 布局（左→右）：视图定向 · 显示样式 · 隐藏/显示 · 布景 · 剖面 · 整屏显示 · 缩放至区域 · 上一视图 · 视图设置 · 显示模式
  const huOrient = btn('view.orientation', '视图定向', 'viewOrient', () => openViewOrientation(app));
  const huStyle = dropdown('view.displayStyle', '显示样式', 'displayStyle2', () => {
    const mk = (label: string, ic: string, style: string) => ({
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
  });
  const huHide = dropdown('view.hideShow', '隐藏/显示项目', 'hideShowItems', () => [
    { label: '基准面', icon: 'plane', checked: app.showPlanes, run: () => app.togglePlanes(!app.showPlanes) },
    { label: '网格', icon: 'grid', checked: app.showGrid, run: () => app.toggleGrid(!app.showGrid) },
    { label: '原点', icon: 'origin', checked: app.showOrigin, run: () => app.toggleOrigin(!app.showOrigin) },
  ]);
  const huScene = dropdown('view.scene', '应用布景', 'applyScene', () =>
    (['默认', '单色灰', '深色', '白色'] as const).map((n) => ({
      label: n,
      icon: 'applyScene',
      checked: app.sceneName === n,
      run: () => app.setScene(n),
    }))
  );
  const huSection = dropdown('view.section', '剖面视图', 'sectionCut', () => [
    { label: '关闭剖面', icon: 'sectionCut', checked: app.sectionAxis === 'none', run: () => app.setSection('none') },
    { sep: true },
    { label: '沿 X 轴剖切', icon: 'right', checked: app.sectionAxis === 'x', run: () => app.setSection('x') },
    { label: '沿 Y 轴剖切', icon: 'top', checked: app.sectionAxis === 'y', run: () => app.setSection('y') },
    { label: '沿 Z 轴剖切', icon: 'front', checked: app.sectionAxis === 'z', run: () => app.setSection('z') },
  ]);
  const huFit = btn('view.fit', '整屏显示', 'zoomFit', () => app.zoomFit());
  const huZoom = btn('view.zoomArea', '缩放至区域', 'zoomArea', () => startZoomArea(app));
  const huZoomIn = btn('view.zoomIn', '放大', 'zoomIn', () => app.viewport.zoomBy(0.8));
  const huZoomOut = btn('view.zoomOut', '缩小', 'zoomOut', () => app.viewport.zoomBy(1.25));
  const huPrev = btn('view.prevView', '上一视图', 'prevView', () => app.prevView());
  // 旋转视图：切换式临时模式（左键拖动即旋转；Esc 或再次点击退出）
  let rotateActive = false;
  const huRotate = btn('view.rotate', '旋转视图', 'rotateView', () => {
    rotateActive = !rotateActive;
    setRotateMode(app, rotateActive);
    huRotate.classList.toggle('on', rotateActive);
  });
  const huAppearance = dropdown('view.appearance', '编辑外观', 'appearance', () =>
    APPEARANCE_COLORS.map((c) => ({
      label: c.label,
      icon: 'appearance',
      color: `#${c.hex.toString(16).padStart(6, '0')}`,
      checked: app.appearanceHex === c.hex,
      run: () => {
        app.setAppearance(c.hex);
        notify.ok(`外观已改为${c.label}`);
      },
    }))
  );
  const huLighting = dropdown('view.lighting', '光源', 'lighting', () =>
    LIGHT_PRESET_NAMES.map((n) => ({
      label: n,
      icon: 'lighting',
      checked: app.lightPreset === n,
      run: () => app.setLightPreset(n),
    }))
  );
  const huSet = btn('view.settings', '视图设置', 'viewSettings', () => openViewSettings(app));
  const huProj = dropdown('view.projection', '显示模式', 'perspective', () => [
    {
      label: '透视',
      icon: 'perspective',
      checked: app.projection === 'perspective',
      run: () => app.setProjection('perspective'),
    },
    {
      label: '正投影',
      icon: 'orthographic',
      checked: app.projection === 'orthographic',
      run: () => app.setProjection('orthographic'),
    },
  ]);
  bar.append(
    huOrient,
    huStyle,
    huHide,
    huScene,
    huSection,
    huFit,
    huZoom,
    huZoomIn,
    huZoomOut,
    huPrev,
    huRotate,
    huAppearance,
    huLighting,
    huSet,
    huProj
  );

  host.appendChild(bar);

  // 显示样式 / 剖面 / 投影 变化时刷新勾选态
  const refresh = () => {
    bar.querySelectorAll('.hu-btn').forEach((b) => {
      const id = (b as HTMLElement).dataset.cmd ?? '';
      b.classList.toggle('on', id === 'view.section' && app.sectionAxis !== 'none');
    });
    huRotate.classList.toggle('on', rotateActive);
  };
  refresh();
  app.on('view', refresh);
  installRotateModeEsc(app, () => rotateActive, () => {
    rotateActive = false;
    setRotateMode(app, false);
    huRotate.classList.remove('on');
  });
}

/** 视图定向（SolidWorks: 空格键）—— 命名视图 + 缩放比例 */
export function openViewOrientation(app: App, at?: { x: number; y: number }): void {
  const pos = at ?? { x: window.innerWidth / 2 - 110, y: 120 };
  openPopup(
    [
      { label: '前视', icon: 'front', sc: sc('view.front'), run: () => app.setView('front') },
      { label: '后视', icon: 'front', sc: sc('view.back'), run: () => app.setView('back') },
      { label: '左视', icon: 'left', sc: sc('view.left'), run: () => app.setView('left') },
      { label: '右视', icon: 'right', sc: sc('view.right'), run: () => app.setView('right') },
      { label: '俯视', icon: 'top', sc: sc('view.top'), run: () => app.setView('top') },
      { label: '仰视', icon: 'top', sc: sc('view.bottom'), run: () => app.setView('bottom') },
      { label: '等轴测', icon: 'isometric', sc: sc('view.iso'), run: () => app.setView('iso') },
      { sep: true },
      { label: '正视于', icon: 'normalTo', sc: sc('view.normalTo'), run: () => app.normalToSelection() },
      { label: '整屏显示', icon: 'zoomFit', sc: sc('view.fit'), run: () => app.zoomFit() },
      { label: '上一视图', icon: 'prevView', sc: sc('view.prevView'), run: () => app.prevView() },
      { sep: true },
      { label: '更多视图设置…', icon: 'viewSettings', run: () => openViewSettings(app) },
    ],
    pos.x,
    pos.y,
    { minWidth: 190 }
  );
}

/** 视图设置对话框（SolidWorks「视图设置」） */
export function openViewSettings(app: App): void {
  const row = (label: string, checked: boolean, onChange: (v: boolean) => void) => {
    const inp = el('input', { type: 'checkbox', checked }) as HTMLInputElement;
    inp.addEventListener('change', () => onChange(inp.checked));
    return el('label', { class: 'chk' }, inp, el('span', { text: label }));
  };

  const body = el(
    'div',
    { class: 'col' },
    row('显示基准面', app.showPlanes, (v) => app.togglePlanes(v)),
    row('显示网格', app.showGrid, (v) => app.toggleGrid(v)),
    row('显示原点', app.showOrigin, (v) => app.toggleOrigin(v)),
    el('div', { class: 'dd-sep' }),
    el(
      'div',
      { class: 'field' },
      el('label', { text: '投影模式' }),
      el(
        'div',
        { class: 'val' },
        (() => {
          const s = el(
            'select',
            { class: 'inp' },
            el('option', { value: 'perspective', text: '透视' }),
            el('option', { value: 'orthographic', text: '正投影' })
          ) as HTMLSelectElement;
          s.value = app.projection;
          s.addEventListener('change', () => app.setProjection(s.value as 'perspective' | 'orthographic'));
          return s;
        })()
      )
    ),
    el(
      'div',
      { class: 'field' },
      el('label', { text: '布景' }),
      el(
        'div',
        { class: 'val' },
        (() => {
          const s = el(
            'select',
            { class: 'inp' },
            ...(['默认', '单色灰', '深色', '白色'] as const).map((n) => el('option', { value: n, text: n }))
          ) as HTMLSelectElement;
          s.value = app.sceneName;
          s.addEventListener('change', () => app.setScene(s.value as never));
          return s;
        })()
      )
    ),
    el('div', { class: 'hint', text: '鼠标：中键拖动旋转 · Ctrl+中键拖动平移 · Shift+中键拖动缩放 · 滚轮缩放 · 右键拖动鼠标手势' })
  );

  modal({
    title: '视图设置',
    body,
    actions: [
      { label: '关闭' },
      { label: '整屏显示', primary: true, onClick: () => app.zoomFit() },
    ],
    width: 420,
  });
}

// ============================================================
// 缩放至区域
// ============================================================
function startZoomArea(app: App): void {
  const canvas = app.viewport.renderer.domElement;
  const wrap = canvas.parentElement;
  if (!wrap) return;
  if (wrap.querySelector('.zoom-rubber')) return;

  const rect = el('div', { class: 'zoom-rubber' });
  wrap.appendChild(rect);
  wrap.classList.add('zooming');
  app.setStatus('缩放至区域：拖出一个矩形框', 'busy');

  let sx = 0;
  let sy = 0;
  let drawing = false;
  const canvasRect = () => canvas.getBoundingClientRect();

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const r = canvasRect();
    sx = e.clientX - r.left;
    sy = e.clientY - r.top;
    drawing = true;
    rect.style.display = '';
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    if (!drawing) return;
    const r = canvasRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const x = Math.min(sx, cx);
    const y = Math.min(sy, cy);
    const w = Math.abs(cx - sx);
    const h = Math.abs(cy - sy);
    rect.style.left = `${x}px`;
    rect.style.top = `${y}px`;
    rect.style.width = `${w}px`;
    rect.style.height = `${h}px`;
  };
  const finish = (e: PointerEvent) => {
    const r = canvasRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const box = {
      x: Math.min(sx, cx),
      y: Math.min(sy, cy),
      w: Math.abs(cx - sx),
      h: Math.abs(cy - sy),
    };
    cleanup();
    if (box.w < 8 || box.h < 8) {
      app.setStatus('缩放至区域：已取消（框太小）', 'ok');
      return;
    }
    app.zoomArea(box);
    notify.ok('已缩放至所选区域');
  };

  const cleanup = () => {
    drawing = false;
    rect.remove();
    wrap.classList.remove('zooming');
    canvas.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    document.removeEventListener('keydown', onEsc, true);
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
      app.setStatus('缩放至区域：已取消', 'ok');
    }
  };

  canvas.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', finish);
  document.addEventListener('keydown', onEsc, true);
}

/** 供上下文菜单复用的显示样式项 */
export function displayStyleItems(app: App): PopupItem[] {
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
  ];
}

/** 供上下文菜单复用的「参考几何体」项 */
export function referenceItems(app: App): PopupItem[] {
  return [
    { label: '基准面', icon: 'plane', run: () => featureDialogs.referencePlane(app) },
    { label: '基准轴', icon: 'axis', disabled: true },
    { label: '坐标系', icon: 'coordSystem', disabled: true },
  ];
}

// ============================================================
// 旋转视图（临时模式）
// ============================================================

/**
 * 切换「旋转视图」模式（SolidWorks 同名工具）。
 * 与中键旋转同一套 OrbitControls，区别是：左键在模式内也能旋转，Esc 退出。
 */
export function setRotateMode(app: App, on: boolean): void {
  const canvas = app.viewport.renderer.domElement;
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const mb = app.viewport.controls.mouseButtons as unknown as { LEFT: THREE.MOUSE | null };
  wrap.classList.toggle('view-rotating', on);
  mb.LEFT = on ? THREE.MOUSE.ROTATE : null;
  if (on) {
    app.clearSelection();
    app.setStatus('旋转视图：拖动左键旋转视角，Esc 退出', 'busy');
  } else {
    app.setStatus('就绪', 'ok');
  }
  app.viewport.invalidate();
}

/** 旋转视图模式下的 Esc 退出（在 buildHeadsUp 尾部调用） */
export function installRotateModeEsc(app: App, onActive: () => boolean, off: () => void): void {
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && onActive()) {
        e.preventDefault();
        e.stopPropagation();
        off();
      }
    },
    true
  );
}
