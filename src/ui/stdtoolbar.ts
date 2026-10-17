/**
 * Standard 工具栏（SolidWorks「标准」工具栏）—— 菜单栏下方的一行常用图标按钮：
 *   新建 · 打开 · 保存 · 打印 | 撤销 · 重建（重做并入撤销组）| 选项 · 帮助
 * 与 ribbon「标准」组互补：这里常驻一行，符合 SolidWorks 默认界面。
 */
import { el, clear } from './dom';
import { icon } from './icons';
import type { AppApi } from '../app/app-api';
import { openViewSettings } from './headsup';

interface StdBtn {
  id: string;
  label: string;
  ic: string;
  tip: string;
  run: (app: AppApi) => void;
  enabled?: (app: AppApi) => boolean;
}

const BUTTONS: (StdBtn | 'sep')[] = [
  { id: 'new', label: '新建', ic: 'new', tip: '新建 (Ctrl+N)', run: (a) => a.newDocument('model') },
  { id: 'open', label: '打开', ic: 'open', tip: '打开 (Ctrl+O)', run: (a) => a.openProject() },
  { id: 'save', label: '保存', ic: 'save', tip: '保存 (Ctrl+S)', run: (a) => a.saveProject() },
  { id: 'print', label: '打印', ic: 'print', tip: '打印 (Ctrl+P)', run: (a) => a.printView() },
  'sep',
  { id: 'undo', label: '撤销', ic: 'undo', tip: '撤销 (Ctrl+Z)', run: (a) => a.undo(), enabled: (a) => a.canUndo },
  { id: 'redo', label: '重做', ic: 'redo', tip: '重做 (Ctrl+Y)', run: (a) => a.redo(), enabled: (a) => a.canRedo },
  { id: 'rebuild', label: '重建', ic: 'rebuild', tip: '重建模型 (Ctrl+B)', run: (a) => a.rebuildModel() },
  'sep',
  { id: 'options', label: '选项', ic: 'options', tip: '视图设置 / 选项', run: (a) => openViewSettings(a) },
  { id: 'help', label: '帮助', ic: 'help', tip: '快捷键一览', run: () => window.dispatchEvent(new CustomEvent('solid2:help')) },
];

export function buildStdToolbar(app: AppApi, host: HTMLElement): void {
  const render = () => {
    clear(host);
    for (const b of BUTTONS) {
      if (b === 'sep') {
        host.appendChild(el('span', { class: 'std-sep' }));
        continue;
      }
      const en = b.enabled ? b.enabled(app) : true;
      const btn = el(
        'button',
        {
          class: `sbtn ${en ? '' : 'disabled'}`.trim(),
          type: 'button',
          title: b.tip,
          dataset: { cmd: `std.${b.id}` },
          onClick: () => en && b.run(app),
        },
        el('span', { class: 'ic', html: icon(b.ic, 18) })
      );
      host.appendChild(btn);
    }
  };
  render();
  // 撤销 / 重做可用性随模型变化刷新
  app.on('change', render);
  app.on('props', render);
}
