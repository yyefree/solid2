/**
 * 属性管理器（右侧面板）。
 */
import { el, clear, numberField, checkField, section } from './dom';
import type { App } from '../app/app';
import { FEATURE_LABEL } from '../doc/types';
import { featureDialogs } from './dialogs';

export function buildPropertyPanel(app: App, host: HTMLElement): void {
  const render = () => {
    clear(host);
    if (app.mode === 'sketch') { renderSketchProps(app, host); return; }
    if (app.mode === 'assembly') { renderAssemblyProps(app, host); return; }
    if (app.mode === 'drawing') { renderDrawingProps(app, host); return; }
    renderModelProps(app, host);
  };
  render();
  app.on('props', render);
  app.on('mode', render);
  app.on('selection', render);
  app.on('params', render);
}

function renderModelProps(app: App, host: HTMLElement) {
  const sel = app.doc.features.length > 0 ? app.doc.features[app.doc.features.length - 1] : null;
  if (!sel) {
    host.appendChild(el('div', { class: 'hint', text: '在左侧特征树中选择一个特征以编辑属性' }));
    return;
  }
  const wrap = el('div', { class: 'col' });
  wrap.appendChild(section('特征', el('div', { class: 'col' },
    el('div', { class: 'field' }, el('label', { text: '名称' }), el('div', { class: 'val mono', text: sel.name })),
    el('div', { class: 'field' }, el('label', { text: '类型' }), el('div', { class: 'val', text: FEATURE_LABEL[sel.type] ?? sel.type })),
  )));

  if (sel.type === 'extrude') {
    const p = sel.params as any;
    const d = numberField('距离', p.distance, (v) => app.updateFeatureParams(sel.id, { distance: v }), { unit: 'mm' });
    const rev = checkField('反向', !!p.reverse, (v) => app.updateFeatureParams(sel.id, { reverse: v }));
    const sym = checkField('对称', !!p.symmetric, (v) => app.updateFeatureParams(sel.id, { symmetric: v }));
    wrap.appendChild(section('参数', el('div', { class: 'col' }, d.row, rev.row, sym.row)));
  }
  if (sel.type === 'revolve') {
    const p = sel.params as any;
    const a = numberField('角度 (°)', p.angleDeg, (v) => app.updateFeatureParams(sel.id, { angleDeg: v }), {});
    wrap.appendChild(section('参数', a.row));
  }
  if (sel.type === 'fillet') {
    const p = sel.params as any;
    const r = numberField('半径', p.radius, (v) => app.updateFeatureParams(sel.id, { radius: v }), { unit: 'mm' });
    wrap.appendChild(section('参数', r.row));
  }
  if (sel.type === 'chamfer') {
    const p = sel.params as any;
    const d = numberField('距离', p.distance, (v) => app.updateFeatureParams(sel.id, { distance: v }), { unit: 'mm' });
    wrap.appendChild(section('参数', d.row));
  }
  if (sel.type === 'shell') {
    const p = sel.params as any;
    const t = numberField('厚度', p.thickness, (v) => app.updateFeatureParams(sel.id, { thickness: v }), { unit: 'mm' });
    wrap.appendChild(section('参数', t.row));
  }
  if (sel.type === 'primitive') {
    const p = sel.params as any;
    const wrap2 = el('div', { class: 'col' });
    for (let i = 0; i < p.dims.length; i++) {
      const f = numberField(`尺寸 ${i + 1}`, p.dims[i], (v) => {
        const dims = [...p.dims];
        dims[i] = v;
        app.updateFeatureParams(sel.id, { dims });
      }, { unit: 'mm' });
      wrap2.appendChild(f.row);
    }
    wrap.appendChild(section('参数', wrap2));
  }
  if (sel.type === 'linearPattern') {
    const p = sel.params as any;
    const sp = numberField('间距', p.spacing, (v) => app.updateFeatureParams(sel.id, { spacing: v }), { unit: 'mm' });
    const cnt = numberField('数量', p.count, (v) => app.updateFeatureParams(sel.id, { count: Math.max(2, Math.round(v)) }), { step: 1 });
    wrap.appendChild(section('参数', el('div', { class: 'col' }, sp.row, cnt.row)));
  }
  if (sel.type === 'circularPattern') {
    const p = sel.params as any;
    const cnt = numberField('数量', p.count, (v) => app.updateFeatureParams(sel.id, { count: Math.max(2, Math.round(v)) }), { step: 1 });
    const ang = numberField('总角度 (°)', p.totalAngleDeg, (v) => app.updateFeatureParams(sel.id, { totalAngleDeg: v }), {});
    wrap.appendChild(section('参数', el('div', { class: 'col' }, cnt.row, ang.row)));
  }
  if (sel.type === 'hole') {
    const p = sel.params as any;
    const col = el('div', { class: 'col' });
    col.appendChild(numberField('孔径 Φ', p.diameter, (v) => app.updateFeatureParams(sel.id, { diameter: v }), { min: 0.1, step: 0.5, unit: 'mm' }).row);
    col.appendChild(checkField('通孔', !!p.through, (v) => app.updateFeatureParams(sel.id, { through: v })).row);
    if (!p.through) {
      col.appendChild(numberField('孔深', p.depth, (v) => app.updateFeatureParams(sel.id, { depth: v }), { min: 0.1, step: 1, unit: 'mm' }).row);
    }
    if (p.type === 'counterbore') {
      col.appendChild(numberField('沉头直径 Φ', p.boreDiameter, (v) => app.updateFeatureParams(sel.id, { boreDiameter: v }), { min: 0.1, step: 0.5, unit: 'mm' }).row);
      col.appendChild(numberField('沉头深度', p.boreDepth, (v) => app.updateFeatureParams(sel.id, { boreDepth: v }), { min: 0.1, step: 0.5, unit: 'mm' }).row);
    }
    if (p.type === 'countersink') {
      col.appendChild(numberField('锥沉直径 Φ', p.sinkDiameter, (v) => app.updateFeatureParams(sel.id, { sinkDiameter: v }), { min: 0.1, step: 0.5, unit: 'mm' }).row);
      col.appendChild(numberField('锥沉深度', p.sinkDepth, (v) => app.updateFeatureParams(sel.id, { sinkDepth: v }), { min: 0.1, step: 0.5, unit: 'mm' }).row);
    }
    wrap.appendChild(section('参数', col));
  }
  if (sel.type === 'referencePlane') {
    const p = sel.params as any;
    const info = el('div', { class: 'col' },
      el('div', { class: 'field' }, el('label', { text: '偏移距离' }), el('div', { class: 'val mono', text: `${round(p.distance ?? 0)} mm` })),
      el('div', { class: 'field' }, el('label', { text: '原点' }), el('div', { class: 'val mono', text: `(${p.plane.origin.map((n: number) => round(n)).join(', ')})` })),
    );
    wrap.appendChild(section('参数', info));
  }
  if (sel.type === 'draft') {
    const p = sel.params as any;
    const col = el('div', { class: 'col' });
    col.appendChild(numberField('拔模角 (°)', p.angleDeg, (v) => app.updateFeatureParams(sel.id, { angleDeg: v }), { min: 0, max: 89, step: 1 }).row);
    col.appendChild(checkField('反向', !!p.reverse, (v) => app.updateFeatureParams(sel.id, { reverse: v })).row);
    wrap.appendChild(section('参数', col));
  }
  if (sel.type === 'rib') {
    const p = sel.params as any;
    const col = el('div', { class: 'col' });
    col.appendChild(numberField('厚度', p.thickness, (v) => app.updateFeatureParams(sel.id, { thickness: v }), { min: 0.1, step: 0.5, unit: 'mm' }).row);
    col.appendChild(numberField('深度', p.depth ?? 10, (v) => app.updateFeatureParams(sel.id, { depth: v }), { min: 0.1, step: 1, unit: 'mm' }).row);
    col.appendChild(checkField('对称', !!p.symmetric, (v) => app.updateFeatureParams(sel.id, { symmetric: v })).row);
    wrap.appendChild(section('参数', col));
  }

  // ---- 表达式（参考 FreeCAD Expressions）----
  const bound = app.featureExpressionRows(sel.id);
  const expBody = el('div', { class: 'col' });
  if (bound.length) {
    const list = el('div', { class: 'list' });
    for (const b of bound) {
      const item = el('div', { class: 'list-item' },
        el('span', { text: b.label }),
        el('span', { class: 'mono', text: b.expr }),
        b.error
          ? el('span', { class: 'tag r', text: '错误' })
          : el('span', { class: 'tag g', text: b.value === undefined ? '—' : String(Math.round(b.value * 100) / 100) }),
      );
      if (b.error) item.title = b.error;
      const del = el('button', { class: 'x', type: 'button', text: '×', title: '解除绑定' });
      del.addEventListener('click', () => app.removeFeatureExpression(sel.id, b.path));
      item.appendChild(del);
      list.appendChild(item);
    }
    expBody.appendChild(list);
    expBody.appendChild(el('div', { class: 'hint', text: '以上参数由公式驱动，字面值被忽略。' }));
  } else {
    expBody.appendChild(el('div', { class: 'hint', text: '该特征的所有参数都取字面值。' }));
  }
  const openExpr = el('button', { class: 'btn', type: 'button', text: '编辑表达式…' });
  openExpr.addEventListener('click', () => featureDialogs.featureExpression(app));
  expBody.appendChild(el('div', { class: 'field' }, el('label', { text: '' }), el('div', { class: 'val' }, openExpr)));
  wrap.appendChild(section(`表达式（${bound.length}）`, expBody, bound.length > 0));

  host.appendChild(wrap);
}

function renderSketchProps(app: App, host: HTMLElement) {
  const sk = app.editingSketch;
  if (!sk) return;
  const wrap = el('div', { class: 'col' });
  wrap.appendChild(section('草图', el('div', { class: 'col' },
    el('div', { class: 'field' }, el('label', { text: '名称' }), el('div', { class: 'val', text: sk.name })),
  )));
  const list = el('div', { class: 'list' });
  for (const c of sk.params.sketch.constraints) {
    const item = el('div', { class: 'list-item' },
      el('span', { text: `${c.type}${c.value !== undefined ? ' = ' + round(c.value) : ''}` }),
      el('span', { class: 'x', text: '×', onClick: () => app.sketch.removeConstraint(c.id) }),
    );
    list.appendChild(item);
  }
  wrap.appendChild(section(`约束 (${sk.params.sketch.constraints.length})`, list));
  host.appendChild(wrap);
}

function renderAssemblyProps(app: App, host: HTMLElement) {
  const a = app.assembly;
  if (!a) return;
  const wrap = el('div', { class: 'col' });
  const list = el('div', { class: 'list' });
  for (const c of a.components) {
    list.appendChild(el('div', { class: 'list-item' },
      el('span', { text: c.name }),
      el('span', { class: 'tag ' + (c.fixed ? 'g' : ''), text: c.fixed ? '固定' : '浮动' }),
    ));
  }
  wrap.appendChild(section(`组件 (${a.components.length})`, list));
  const mlist = el('div', { class: 'list' });
  for (const m of a.mates) {
    mlist.appendChild(el('div', { class: 'list-item' },
      el('span', { text: m.name }),
      m.error ? el('span', { class: 'tag r', text: '错误' }) : null,
    ));
  }
  wrap.appendChild(section(`配合 (${a.mates.length})`, mlist));
  host.appendChild(wrap);
}

function renderDrawingProps(app: App, host: HTMLElement) {
  const d = app.drawing;
  if (!d) return;
  const wrap = el('div', { class: 'col' });
  wrap.appendChild(section('图纸', el('div', { class: 'col' },
    el('div', { class: 'field' }, el('label', { text: '名称' }), el('div', { class: 'val', text: d.sheet.title })),
    el('div', { class: 'field' }, el('label', { text: '比例' }), el('div', { class: 'val', text: d.views[0] ? `1:${(1/d.views[0].scale).toFixed(2)}` : '1:1' })),
    el('div', { class: 'field' }, el('label', { text: '视图数' }), el('div', { class: 'val', text: String(d.views.length) })),
  )));
  host.appendChild(wrap);
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
