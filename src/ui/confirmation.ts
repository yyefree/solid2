/**
 * 确认角（SolidWorks Confirmation Corner）—— 图形区右上角的 ✓ / ✗。
 * 当有命令处于激活状态（编辑草图 / 选择集待确认）时出现。
 */
import { el } from './dom';
import type { AppApi } from '../app/app-api';

export function buildConfirmationCorner(app: AppApi, host: HTMLElement): void {
  const ok = el('button', { class: 'cc-btn cc-ok', type: 'button', title: '确定（Enter）', text: '✓' });
  const no = el('button', { class: 'cc-btn cc-no', type: 'button', title: '取消（Esc）', text: '✗' });
  const corner = el('div', { class: 'conf-corner' }, ok, no);
  host.appendChild(corner);

  ok.addEventListener('click', () => {
    if (app.mode === 'sketch') app.exitSketch(false);
    else app.clearSelection();
  });
  no.addEventListener('click', () => {
    if (app.mode === 'sketch') app.exitSketch(true);
    else app.clearSelection();
  });

  const refresh = () => {
    const active = app.mode === 'sketch' || app.selection.faces.length + app.selection.edges.length > 0;
    corner.classList.toggle('show', active);
    ok.title = app.mode === 'sketch' ? '确定并退出草图（Enter）' : '清除选择';
    no.title = app.mode === 'sketch' ? '放弃草图（Esc）' : '清除选择';
  };
  refresh();
  app.on('mode', refresh);
  app.on('selection', refresh);
  app.on('command', refresh);
}
