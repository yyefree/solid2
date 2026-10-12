/**
 * 顶部菜单栏。
 */
import { el } from './dom';
import type { App } from '../app/app';
import { featureDialogs } from './dialogs';

export function buildMenubar(app: App, host: HTMLElement): void {
  host.appendChild(el('div', { class: 'brand' }, 'Solid', el('b', { text: '2' })));

  const menus = [
    {
      label: '文件',
      items: [
        { label: '新建', sc: 'Ctrl+N', run: () => { /* 由 ribbon 处理 */ } },
        { label: '打开', sc: 'Ctrl+O', run: () => app.openProject() },
        { label: '保存', sc: 'Ctrl+S', run: () => app.saveProject() },
        { label: 'sep' },
        { label: '导出 STEP', run: () => app.exportStep() },
        { label: '导出 STL', run: () => app.exportStl() },
        { label: '导出 OBJ', run: () => app.exportObj() },
      ],
    },
    {
      label: '编辑',
      items: [
        { label: '撤销', sc: 'Ctrl+Z', run: () => app.undo() },
        { label: '重做', sc: 'Ctrl+Y', run: () => app.redo() },
        { label: '重建', run: () => app.rebuild() },
      ],
    },
    {
      label: '视图',
      items: [
        { label: '主视', run: () => app.setView('front') },
        { label: '俯视', run: () => app.setView('top') },
        { label: '右视', run: () => app.setView('right') },
        { label: '等轴测', run: () => app.setView('iso') },
        { label: 'sep' },
        { label: '整屏显示', run: () => app.zoomFit() },
      ],
    },
    {
      label: '工具',
      items: [
        { label: '参数表', run: () => featureDialogs.parameterTable(app) },
        { label: '表达式', run: () => featureDialogs.featureExpression(app) },
        { label: 'sep' },
        { label: '质量属性', run: () => app.showMassProperties() },
        { label: '测量距离', run: () => app.measureDistance() },
      ],
    },
  ];

  for (const m of menus) {
    const btn = el('button', { class: 'menu-item', text: m.label });
    let dd: HTMLElement | null = null;
    btn.addEventListener('click', () => {
      if (dd) { dd.remove(); dd = null; return; }
      dd = el('div', { class: 'dropdown' });
      const rect = btn.getBoundingClientRect();
      dd.style.left = `${rect.left}px`;
      dd.style.top = `${rect.bottom}px`;
      for (const item of m.items) {
        if ((item as any).label === 'sep') {
          dd.appendChild(el('div', { class: 'dd-sep' }));
          continue;
        }
        dd.appendChild(el('button', {
          class: 'dd-item',
          onClick: () => { (item as any).run(); dd?.remove(); dd = null; },
        }, el('span', { text: (item as any).label }), el('span', { class: 'sc', text: (item as any).sc ?? '' })));
      }
      document.body.appendChild(dd);
      setTimeout(() => document.addEventListener('mousedown', (e) => {
        if (!dd?.contains(e.target as Node)) { dd?.remove(); dd = null; }
      }, { once: true }), 10);
    });
    host.appendChild(btn);
  }

  host.appendChild(el('div', { class: 'menu-title', text: 'Solid2 参数化三维 CAD' }));
}
