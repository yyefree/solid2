/**
 * 特征管理器（左侧设计树）。
 */
import { el, clear } from './dom';
import { icon } from './icons';
import type { App } from '../app/app';
import { FEATURE_LABEL, FEATURE_ICON } from '../doc/types';
import { notify, confirmDialog } from './toast';

export function buildFeatureTree(app: App, host: HTMLElement): void {
  const render = () => {
    clear(host);
    const tree = el('div', { class: 'tree' });
    const feats = app.doc.features;
    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      const isSketch = f.type === 'sketch';
      const isActive = app.editingSketch?.id === f.id;
      const node = el('div', {
        class: `tnode ${f.error ? 'err' : ''} ${f.suppressed ? 'suppressed' : ''} ${isActive ? 'sel' : ''}`.trim(),
      },
        el('span', { class: 'tw' }),
        el('span', { class: 'ic', html: icon(FEATURE_ICON[f.type] ?? 'part', 15) }),
        el('span', { class: 'label', text: f.name }),
        f.error ? el('span', { class: 'badge', text: '!' }) : null,
      );
      node.addEventListener('click', () => {
        // 特征树点击暂不做选择（后续可扩展）
      });
      node.addEventListener('dblclick', () => {
        if (isSketch && app.mode !== 'sketch') app.enterSketch(f as any);
      });
      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCtx(app, f.id, e.clientX, e.clientY);
      });
      tree.appendChild(node);
    }
    if (!feats.length) {
      tree.appendChild(el('div', { class: 'hint', text: '特征树为空。先创建草图，再添加拉伸/旋转等特征。' }));
    }
    host.appendChild(tree);
  };
  render();
  app.on('tree', render);
  app.on('mode', render);
}

function showCtx(app: App, id: string, x: number, y: number) {
  const dd = el('div', { class: 'dropdown', style: { left: `${x}px`, top: `${y}px` } });
  const feat = app.doc.getFeature(id);
  const items: { label: string; run: () => void }[] = [
    { label: '删除', run: () => confirmDialog('删除特征', '确定删除该特征？', () => app.removeFeature(id)) },
    { label: '上移', run: () => { app.doc.move(id, -1); app.rebuild(); } },
    { label: '下移', run: () => { app.doc.move(id, 1); app.rebuild(); } },
    { label: feat?.suppressed ? '恢复' : '抑制', run: () => {
      const f = app.doc.getFeature(id);
      if (f) { f.suppressed = !f.suppressed; app.rebuild(); }
    } },
  ];
  for (const item of items) {
    dd.appendChild(el('button', {
      class: 'dd-item', text: item.label,
      onClick: () => { item.run(); dd.remove(); },
    }));
  }
  document.body.appendChild(dd);
  setTimeout(() => document.addEventListener('mousedown', (e) => {
    if (!dd.contains(e.target as Node)) dd.remove();
  }, { once: true }), 10);
}
