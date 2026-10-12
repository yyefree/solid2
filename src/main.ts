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
import { buildMenubar } from './ui/menubar';
import { buildStatusbar } from './ui/statusbar';
import { buildViewcube } from './ui/viewcube';
import { buildDrawingView } from './ui/drawingview';
import { el } from './ui/dom';
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
    const ribbonTabsEl = el('div', { class: 'ribbon-tabs' });
    const ribbonPanelEl = el('div', { class: 'ribbon' });
    const mainEl = el('div', { class: 'main' });

    const leftPanel = el('div', { class: 'panel panel-left' });
    const leftTabs = el('div', { class: 'panel-tabs' });
    const leftBody = el('div', { class: 'panel-body' });
    leftPanel.append(leftTabs, leftBody);

    const viewportWrap = el('div', { class: 'viewport-wrap' });
    const viewportEl = el('div', { class: 'viewport' });
    const drawingWrap = el('div', { class: 'drawing-wrap hidden' });
    viewportWrap.append(viewportEl, drawingWrap);

    const rightPanel = el('div', { class: 'panel panel-right' });
    const rightTabs = el('div', { class: 'panel-tabs' });
    const rightBody = el('div', { class: 'panel-body' });
    rightPanel.append(rightTabs, rightBody);

    mainEl.append(leftPanel, viewportWrap, rightPanel);
    const statusbarEl = el('div', { class: 'statusbar' });

    appRoot.append(menubarEl, ribbonTabsEl, ribbonPanelEl, mainEl, statusbarEl);
    appHost.appendChild(appRoot);

    // ---------- 面板标签 ----------
    leftTabs.appendChild(el('button', { class: 'ptab active', text: '特征树' }));
    leftTabs.appendChild(el('button', { class: 'ptab', text: '配置' }));
    rightTabs.appendChild(el('button', { class: 'ptab active', text: '属性' }));
    rightTabs.appendChild(el('button', { class: 'ptab', text: '外观' }));

    // ---------- 初始化 App ----------
    const app = new App(viewportEl);
    app.drawingHost = drawingWrap;

    // 开发模式：暴露调试句柄，供浏览器端到端冒烟测试驱动真实 Worker 内核。
    // 生产构建下 import.meta.env.DEV 为 false，此分支会被 Vite 静态消除（不进产物）。
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__solid2 = { app, kernel };
    }

    // ---------- 挂载 UI ----------
    buildMenubar(app, menubarEl);
    renderRibbon(app, ribbonTabsEl, ribbonPanelEl);
    buildFeatureTree(app, leftBody);
    buildPropertyPanel(app, rightBody);
    buildStatusbar(app, statusbarEl);

    const viewcubeEl = el('div', { class: 'viewcube' });
    viewportWrap.appendChild(viewcubeEl);
    buildViewcube(app, viewcubeEl);

    buildDrawingView(app, drawingWrap);

    // ---------- 视口浮动工具条 ----------
    const vpToolbar = el('div', { class: 'vp-toolbar' });
    vpToolbar.appendChild(el('button', { title: '整屏显示', onClick: () => app.zoomFit() }, '⊡'));
    vpToolbar.appendChild(el('button', { title: '主视', onClick: () => app.setView('front') }, 'F'));
    vpToolbar.appendChild(el('button', { title: '俯视', onClick: () => app.setView('top') }, 'T'));
    vpToolbar.appendChild(el('button', { title: '等轴测', onClick: () => app.setView('iso') }, 'I'));
    viewportWrap.appendChild(vpToolbar);

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
