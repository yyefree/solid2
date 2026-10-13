/**
 * Solid2 启动入口。
 *
 * 启动策略（懒加载内核）：
 *   1. 先快速构建界面并展示（不依赖几何内核）；
 *   2. 启动屏淡出，用户立刻看到 CAD 界面；
 *   3. 后台流式加载 OpenCASCADE WASM（63MB），视口内显示真实进度横幅；
 *   4. 内核就绪后自动 setOcct，横幅消失，状态栏提示"就绪"。
 * 若用户在内核就绪前点击需要内核的命令，ribbon 会自动等加载完成再执行。
 */
import { kernel } from './core/kernel';
import { App } from './app/app';
import { renderRibbon } from './ui/ribbon';
import { buildFeatureTree } from './ui/featuretree';
import { buildPropertyPanel } from './ui/propertypanel';
import { buildTaskPane, buildConfigPanel } from './ui/taskpane';
import { buildMenubar } from './ui/menubar';
import { buildStdToolbar } from './ui/stdtoolbar';
import { buildStatusbar } from './ui/statusbar';
import { buildViewcube } from './ui/viewcube';
import { buildDrawingView } from './ui/drawingview';
import { buildHeadsUp } from './ui/headsup';
import { buildTriad } from './ui/triad';
import { buildConfirmationCorner } from './ui/confirmation';
import { installContextMenu } from './ui/contextmenu';
import { installMouseGestures } from './ui/shortcutbar';
import { installHotkeys } from './app/hotkeys';
import { el, clear } from './ui/dom';
import { icon } from './ui/icons';
import './styles/theme.css';

async function boot() {
  const bootStatus = document.getElementById('boot-status')!;
  const bootFill = document.getElementById('boot-fill') as HTMLElement;

  try {
    bootStatus.textContent = '正在构建界面…';
    bootFill.style.width = '20%';

    const appHost = document.getElementById('app')!;

    // ---------- 构建页面骨架（快，不需要内核） ----------
    const appRoot = el('div', { class: 'app hidden' });
    const menubarEl = el('div', { class: 'menubar' });
    const stdToolbarEl = el('div', { class: 'menubar-std' });
    const ribbonTabsEl = el('div', { class: 'ribbon-tabs' });
    const ribbonPanelEl = el('div', { class: 'ribbon' });
    const mainEl = el('div', { class: 'main' });

    const leftPanel = el('div', { class: 'panel panel-left' });
    const leftTabs = el('div', { class: 'panel-tabs' });
    const leftBodyTree = el('div', { class: 'panel-body' });
    const leftBodyProp = el('div', { class: 'panel-body' });
    const leftBodyCfg = el('div', { class: 'panel-body' });
    leftPanel.append(leftTabs, leftBodyTree, leftBodyProp, leftBodyCfg);

    const viewportWrap = el('div', { class: 'viewport-wrap' });
    const viewportEl = el('div', { class: 'viewport' });
    const drawingWrap = el('div', { class: 'drawing-wrap hidden' });
    viewportWrap.append(viewportEl, drawingWrap);

    const rightPanel = el('div', { class: 'panel panel-right taskpane' });

    mainEl.append(leftPanel, viewportWrap, rightPanel);
    const statusbarEl = el('div', { class: 'statusbar' });

    appRoot.append(menubarEl, stdToolbarEl, ribbonTabsEl, ribbonPanelEl, mainEl, statusbarEl);
    appHost.appendChild(appRoot);

    // ---------- 左侧面板选项卡：特征管理器 / 属性管理器 / 配置管理器 ----------
    const leftTabDefs = [
      { id: 'tree', label: '特征管理器' },
      { id: 'prop', label: '属性管理器' },
      { id: 'cfg', label: '配置管理器' },
    ];
    const leftBodies: Record<string, HTMLElement> = {
      tree: leftBodyTree,
      prop: leftBodyProp,
      cfg: leftBodyCfg,
    };
    let leftActive = 'tree';
    const setLeftTab = (id: string) => {
      leftActive = id;
      for (const t of leftTabDefs) {
        const btn = leftTabs.querySelector(`[data-ltab="${t.id}"]`) as HTMLElement | null;
        if (btn) btn.classList.toggle('active', t.id === id);
      }
      for (const k of Object.keys(leftBodies)) leftBodies[k].style.display = k === id ? '' : 'none';
    };
    for (const t of leftTabDefs) {
      leftTabs.appendChild(
        el('button', { class: `ptab ${t.id === 'tree' ? 'active' : ''}`, type: 'button', text: t.label, dataset: { ltab: t.id }, onClick: () => setLeftTab(t.id) })
      );
    }
    setLeftTab('tree');

    // ---------- 初始化 App ----------
    const app = new App(viewportEl);
    app.drawingHost = drawingWrap;

    // 在设计树选中特征时，自动切到「属性管理器」（SolidWorks 行为）
    app.on('feature', () => {
      if (leftActive !== 'prop') setLeftTab('prop');
    });

    // 开发模式：暴露调试句柄，供浏览器端到端冒烟测试驱动真实 Worker 内核。
    // 生产构建下 import.meta.env.DEV 为 false，此分支会被 Vite 静态消除（不进产物）。
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__solid2 = { app, kernel };
    }

    // ---------- 挂载 UI ----------
    buildMenubar(app, menubarEl);
    buildStdToolbar(app, stdToolbarEl);
    renderRibbon(app, ribbonTabsEl, ribbonPanelEl);
    buildFeatureTree(app, leftBodyTree);
    buildPropertyPanel(app, leftBodyProp);
    buildConfigPanel(app, leftBodyCfg);
    buildTaskPane(app, rightPanel);
    buildStatusbar(app, statusbarEl);

    const viewcubeEl = el('div', { class: 'viewcube' });
    viewportWrap.appendChild(viewcubeEl);
    buildViewcube(app, viewcubeEl);

    buildDrawingView(app, drawingWrap);

    // ---------- SolidWorks 视口浮层 ----------
    // Heads-up 视图工具栏（顶部居中）
    const headsUpEl = el('div', { class: 'headsup-host' });
    viewportWrap.appendChild(headsUpEl);
    buildHeadsUp(app, headsUpEl);

    // 参考三重轴（左下角）
    const triadEl = el('div', { class: 'axis-triad' });
    viewportWrap.appendChild(triadEl);
    buildTriad(app, triadEl);

    // 确认角（✓ / ✗，草图或选择时出现）
    const confirmEl = el('div', { class: 'conf-host' });
    viewportWrap.appendChild(confirmEl);
    buildConfirmationCorner(app, confirmEl);

    // 右键上下文菜单
    installContextMenu(app, viewportEl);
    // 鼠标手势（右键拖动）
    installMouseGestures(app, viewportEl);
    // 全局热键表（SolidWorks 一致）
    installHotkeys(app);

    // ---------- 文档标签栏（SolidWorks 图形区底部：零件 / 装配体 / 工程图） ----------
    const docTabsEl = el('div', { class: 'doc-tabs' });
    viewportWrap.appendChild(docTabsEl);
    const DOC_TABS = [
      { id: 'model', label: '零件', ic: 'part' },
      { id: 'assembly', label: '装配体', ic: 'assembly' },
      { id: 'drawing', label: '工程图', ic: 'drawing' },
    ];
    const renderDocTabs = () => {
      clear(docTabsEl);
      for (const t of DOC_TABS) {
        const active = app.mode === t.id;
        docTabsEl.appendChild(
          el(
            'button',
            {
              class: `dtab ${active ? 'active' : ''}`,
              type: 'button',
              title: `切换到${t.label}`,
              dataset: { dtab: t.id },
              onClick: () => app.setMode(t.id as never),
            },
            el('span', { class: 'ic', html: icon(t.ic, 14) }),
            el('span', { class: 'lbl', text: t.label })
          )
        );
      }
    };
    renderDocTabs();
    app.on('mode', renderDocTabs);

    // ---------- 视口信息浮层 ----------
    const vpInfo = el('div', { class: 'vp-info' });
    viewportWrap.appendChild(vpInfo);
    const updateInfo = () => {
      const s = app.modelSummary();
      vpInfo.textContent = `${s.faces}F · ${s.edges}E · ${s.solids}S`;
    };
    updateInfo();
    app.on('change', updateInfo);

    // ---------- 草图提示浮层 ----------
    const sketchHud = el('div', { class: 'sketch-hud' });
    viewportWrap.appendChild(sketchHud);
    const updateHud = () => {
      const hint = app.sketch.hintText();
      if (hint && app.mode === 'sketch') {
        sketchHud.textContent = hint;
        sketchHud.classList.add('show');
      } else {
        sketchHud.classList.remove('show');
      }
    };
    app.on('props', updateHud);
    app.on('mode', updateHud);

    bootFill.style.width = '100%';

    // ---------- 关闭启动屏，界面先出来 ----------
    const bootScreen = document.getElementById('boot-screen')!;
    setTimeout(() => {
      bootScreen.style.opacity = '0';
      bootScreen.style.transition = 'opacity .4s ease';
      setTimeout(() => {
        bootScreen.remove();
        appRoot.classList.remove('hidden');
        app.viewport.resize();
      }, 420);
    }, 200);

    // ---------- 内核懒加载 + 进度横幅 ----------
    const kbFill = el('i', { id: 'kb-fill' });
    const kbStatus = el('div', { class: 'boot-status', id: 'kb-status', text: '准备中…' });
    const kernelBanner = el(
      'div',
      { class: 'kernel-banner' },
      el('div', { class: 'kb-title', text: 'Solid2 · 几何内核' }),
      el('div', { class: 'boot-bar' }, kbFill),
      kbStatus
    );
    viewportWrap.appendChild(kernelBanner);
    app.setStatus('几何内核加载中…', 'busy');

    kernel.loadKernel((pct, phase) => {
      kbFill.style.width = `${pct}%`;
      kbStatus.textContent = phase;
      app.setStatus(`几何内核加载中 ${pct.toFixed(0)}%`, 'busy');
    })
      .then(() => {
        app.kernelReady = true;
        kernelBanner.remove();
        app.setStatus('几何内核就绪', 'ok');
      })
      .catch((e) => {
        kernelBanner.remove();
        app.setStatus(`内核加载失败：${(e as Error).message}`, 'err');
        kbStatus.textContent = `加载失败：${(e as Error).message}`;
        console.error(e);
      });
  } catch (e) {
    bootStatus.textContent = `启动失败：${(e as Error).message}`;
    bootFill.style.background = '#d9432f';
    console.error(e);
  }
}

boot();
