/**
 * 特征对话框集合 —— 每个命令对应一个交互或确认流程。
 *
 * 原则：简单参数用 promptNumber，多参数用 modal 表单。
 * 所有对话框只操作 App，不直接碰 DOM。
 */
import type { App } from '../app/app';
import { notify, promptNumber, modal, tableModal, confirmDialog } from './toast';
import { formatLength, formatArea, formatVolume } from '../core/units';
import { el, numberField, selectField, checkField, clear, section } from './dom';
import { newId } from '../sketch/types';
import type { ExtrudeFeature, ExtrudeStartCondition, ExtrudeEndCondition, ExtrudeEnd2Condition, ThinType, RevolveFeature, LoftFeature, SweepFeature, PrimitiveFeature, FilletFeature, ChamferFeature, ShellFeature, LinearPatternFeature, CircularPatternFeature, MirrorFeature, HoleFeature, ReferencePlaneFeature, HoleType, DraftFeature, RibFeature, SpringFeature, SpiralFeature, CoilHandedness, BooleanOp, ScaleFeature, SplitFeature, SplitKeep, MoveBodyFeature, DeleteBodyFeature, CombineFeature, CombineOp } from '../doc/types';
import type { SketchPlane } from '../sketch/types';
import { worldToPlane } from '../sketch/types';
import { PLANES, makeEdgeRef, makeFaceRef, CadDocument, planeFromFace, offsetPlane, parallelPlane, perpendicularPlane, angledPlane, planeOf, worldFromSketch } from '../doc/model';
import { download } from '../core/meshexport';
import type { ViewKind, DimAnnotation, GdtSymbol } from '../app/drawing';
import { GDT_LABEL } from '../app/drawing';
import type { MateRef } from '../app/assembly';
import { mateRefLabel } from '../app/assembly';

export const featureDialogs = {
  // ---------------- 草图 ----------------
  sketchOnFace(app: App): void {
    const infos = app.selectedFaceInfos();
    if (infos.length !== 1) { notify.info('请先在模型中选中一个平面'); return; }
    const info = infos[0];
    const pl = sketchPlaneFromNormal(info.normal as [number, number, number], info.centroid as [number, number, number]);
    app.startSketch(pl);
  },

  addRelation(app: App, type: string): void {
    app.sketch.addRelation(type as any);
  },

  smartDimension(app: App): void {
    app.sketch.smartDimension();
  },

  toggleConstruction(app: App): void {
    app.sketch.toggleConstruction();
  },

  deleteSketchSelection(app: App): void {
    app.sketch.deleteSelection();
  },

  /** 镜像实体：以选中的直线为镜像轴，镜像其余选中的实体 */
  mirrorEntities(app: App): void {
    app.sketch.mirrorSelection();
  },

  // ---------------- 基于草图 ----------------
  /** 拉伸凸台 / 切除（SW 式：起始条件 + 方向1终止条件 + 方向2） */
  extrude(app: App, operation: 'add' | 'cut'): void {
    const sketches = app.doc.sketchFeatures();
    if (!sketches.length) { notify.err('没有可用草图'); return; }
    const sketchId = app.editingSketch?.id ?? sketches[sketches.length - 1].id;

    const body = el('div', { class: 'col' });
    // 起始条件（SW「从」下拉）
    const startRow = selectField('起始条件', 'sketchPlane', [
      { value: 'sketchPlane', label: '草图基准面' },
      { value: 'offset', label: '等距' },
    ], () => sync());
    const offRow = numberField('偏移距离', 0, () => {}, { step: 1, unit: 'mm' });
    const offRevRow = checkField('偏移反向', false, () => {});
    // 方向 1（SW「方向 1」下拉）
    const endRow = selectField('方向 1 终止条件', 'blind', [
      { value: 'blind', label: '给定深度' },
      { value: 'upToVertex', label: '成形到顶点' },
      { value: 'upToSurface', label: '成形到面' },
      { value: 'throughAll', label: '完全贯穿' },
      { value: 'midPlane', label: '两侧对称' },
    ], () => sync());
    const distRow = numberField('深度', 10, () => {}, { min: 0.01, step: 1, unit: 'mm' });
    const revRow = checkField('反向', false, () => {});
    const draftRow = numberField('拔模角', 0, () => {}, { step: 1, unit: '°' });
    // 方向 2（两侧不对称）
    const end2Row = selectField('方向 2 终止条件', 'none', [
      { value: 'none', label: '无' },
      { value: 'blind', label: '给定深度' },
      { value: 'throughAll', label: '完全贯穿' },
    ], () => sync());
    const dist2Row = numberField('方向 2 深度', 5, () => {}, { min: 0.01, step: 1, unit: 'mm' });
    // 薄壁特征（SW「薄壁特征」分组）：把轮廓偏置成带状再成形
    const thinEnable = checkField('薄壁特征', false, () => sync());
    const thinTypeRow = selectField('薄壁类型', 'oneSide', [
      { value: 'oneSide', label: '单向' },
      { value: 'midPlane', label: '两侧对称' },
      { value: 'twoSides', label: '两侧不对称' },
    ], () => sync());
    const thinThickRow = numberField('厚度', 1, () => {}, { min: 0.01, step: 0.5, unit: 'mm' });
    const thinThick2Row = numberField('方向 2 厚度', 1, () => {}, { min: 0.01, step: 0.5, unit: 'mm' });
    const thinRevRow = checkField('薄壁反向', false, () => {});
    const hint = el('div', { class: 'hint' }, '');

    function sync() {
      const start = startRow.select.value;
      const end = endRow.select.value;
      const end2 = end2Row.select.value;
      const isOffset = start === 'offset';
      const thinOn = thinEnable.input.checked;
      const thinType = thinTypeRow.select.value;
      offRow.row.style.display = isOffset ? '' : 'none';
      offRevRow.row.style.display = isOffset ? '' : 'none';
      distRow.row.style.display = end === 'blind' || end === 'midPlane' ? '' : 'none';
      revRow.row.style.display = end === 'throughAll' ? 'none' : '';
      dist2Row.row.style.display = end2 === 'blind' ? '' : 'none';
      thinTypeRow.row.style.display = thinOn ? '' : 'none';
      thinThickRow.row.style.display = thinOn ? '' : 'none';
      thinThick2Row.row.style.display = thinOn && thinType === 'twoSides' ? '' : 'none';
      thinRevRow.row.style.display = thinOn && thinType === 'oneSide' ? '' : 'none';
      if (end === 'upToVertex') hint.textContent = `成形到顶点：请先在图形区选中一个顶点（当前选中 ${app.selectedVertexPoints().length} 个）`;
      else if (end === 'upToSurface') hint.textContent = `成形到面：请先在图形区选中一个面（当前选中 ${app.selectedFaceInfos().length} 个）`;
      else if (end === 'throughAll') hint.textContent = '完全贯穿：自动按模型包围盒定长，穿透整个模型（常用于切除）。';
      else if (thinOn) hint.textContent = '薄壁特征：把草图轮廓偏置成带状再成形——开环轮廓偏置成一条带，闭环轮廓偏置成环带（壁厚沿轮廓法向）。';
      else hint.textContent = '深度为正值、沿草图法向；勾选「反向」沿反方向拉伸。方向 2 可向另一侧再拉一段（两侧不对称）。';
    }
    sync();
    const thinGroup = section('薄壁特征', el('div', { class: 'col' },
      thinEnable.row, thinTypeRow.row, thinThickRow.row, thinThick2Row.row, thinRevRow.row));
    body.append(
      startRow.row, offRow.row, offRevRow.row,
      endRow.row, distRow.row, revRow.row, draftRow.row,
      end2Row.row, dist2Row.row,
      thinGroup,
      hint
    );

    modal({
      host: 'pm',
      title: operation === 'add' ? '拉伸凸台' : '拉伸切除',
      body,
      actions: [
        { label: '取消' },
        {
          label: '确定', primary: true, onClick: () => {
            const end = endRow.select.value as ExtrudeEndCondition;
            const start = startRow.select.value as ExtrudeStartCondition;
            const params: ExtrudeFeature['params'] = {
              sketchId,
              distance: parseFloat(distRow.input.value) || 0,
              operation,
              symmetric: false,
              reverse: revRow.input.checked,
              draft: parseFloat(draftRow.input.value) || 0,
              start,
              endCondition: end,
              end2: end2Row.select.value as ExtrudeEnd2Condition,
              distance2: parseFloat(dist2Row.input.value) || 0,
            };
            if (start === 'offset') {
              params.startOffset = parseFloat(offRow.input.value) || 0;
              params.startReverse = offRevRow.input.checked;
            }
            if (thinEnable.input.checked) {
              const thinType = thinTypeRow.select.value as ThinType;
              const th = parseFloat(thinThickRow.input.value) || 0;
              if (!(th > 0)) { notify.err('薄壁厚度必须为正数'); return false; }
              params.thin = {
                type: thinType,
                thickness: th,
                thickness2: parseFloat(thinThick2Row.input.value) || th,
                reverse: thinRevRow.input.checked,
              };
            }
            if (end === 'upToVertex') {
              const pts = app.selectedVertexPoints();
              if (!pts.length) { notify.err('请先在图形区选中一个顶点'); return false; }
              params.vertex = pts[0];
            } else if (end === 'upToSurface') {
              const fs = app.selectedFaceInfos();
              if (!fs.length) { notify.err('请先在图形区选中一个面'); return false; }
              params.targetFace = { point: [...fs[0].centroid], normal: [...fs[0].normal] };
            } else if (end === 'blind' && !(params.distance > 0)) {
              notify.err('深度必须为正数'); return false;
            }
            const f: ExtrudeFeature = {
              id: newId('f'), type: 'extrude', name: app.doc.nextName('extrude'), params,
            };
            app.addFeature(f);
            notify.ok(operation === 'add' ? '已添加拉伸凸台' : '已添加拉伸切除');
            return true;
          },
        },
      ],
    });
  },

  revolve(app: App): void {
    const sketches = app.doc.sketchFeatures();
    if (!sketches.length) { notify.err('没有可用草图'); return; }
    const sketchId = app.editingSketch?.id ?? sketches[sketches.length - 1].id;
    promptNumber('旋转', '角度 (°)', 360, (ang) => {
      const f: RevolveFeature = {
        id: newId('f'), type: 'revolve', name: app.doc.nextName('revolve'),
        params: { sketchId, axisA: [0, 0], axisB: [10, 0], angleDeg: ang, operation: 'add' },
      };
      app.addFeature(f);
    });
  },

  loft(app: App): void {
    const sketches = app.doc.sketchFeatures();
    if (sketches.length < 2) { notify.err('至少需要两个草图'); return; }
    const f: LoftFeature = {
      id: newId('f'), type: 'loft', name: app.doc.nextName('loft'),
      params: { sketchIds: sketches.slice(-2).map(s => s.id), ruled: false, operation: 'add' },
    };
    app.addFeature(f);
  },

  sweep(app: App): void {
    const sketches = app.doc.sketchFeatures();
    if (sketches.length < 2) { notify.err('至少需要两个草图（轮廓 + 路径）'); return; }
    const f: SweepFeature = {
      id: newId('f'), type: 'sweep', name: app.doc.nextName('sweep'),
      params: { profileSketchId: sketches[sketches.length - 2].id, pathSketchId: sketches[sketches.length - 1].id, operation: 'add' },
    };
    app.addFeature(f);
  },

  // ---------------- 曲线族 ----------------
  /** 弹簧：圆截面沿螺旋线放样成实体 */
  spring(app: App): void {
    const hasModel = app.hasModel;
    const body = el('div', { class: 'col' });
    const ox = numberField('轴起点 X', 0, () => {}, { step: 1, unit: 'mm' });
    const oy = numberField('轴起点 Y', 0, () => {}, { step: 1, unit: 'mm' });
    const oz = numberField('轴起点 Z', 0, () => {}, { step: 1, unit: 'mm' });
    const dx = numberField('轴方向 X', 0, () => {}, { step: 0.1 });
    const dy = numberField('轴方向 Y', 0, () => {}, { step: 0.1 });
    const dz = numberField('轴方向 Z', 1, () => {}, { step: 0.1 });
    const meanRow = numberField('中径 Φ', 20, () => {}, { min: 0.2, step: 1, unit: 'mm' });
    const wireRow = numberField('线径 Φ', 2, () => {}, { min: 0.05, step: 0.5, unit: 'mm' });
    const pitchRow = numberField('螺距', 5, () => {}, { min: 0.05, step: 0.5, unit: 'mm' });
    const turnRow = numberField('圈数', 8, () => {}, { min: 0.1, step: 1 });
    const taperRow = numberField('锥度 (°)', 0, () => {}, { min: -60, max: 60, step: 0.5, unit: '°' });
    const segRow = numberField('每圈段数', 24, () => {}, { min: 8, max: 96, step: 4 });
    const handRow = selectField('旋向', 'right', [
      { value: 'right', label: '右旋' },
      { value: 'left', label: '左旋' },
    ], () => {});
    const opRow = selectField('操作', hasModel ? 'add' : 'new', [
      ...(hasModel ? [
        { value: 'add', label: '添加（与现有实体合并）' },
        { value: 'cut', label: '切除（从现有实体减去）' },
      ] : []),
      { value: 'new', label: '新建实体' },
    ], () => {});
    body.append(
      ox.row, oy.row, oz.row, dx.row, dy.row, dz.row,
      meanRow.row, wireRow.row, pitchRow.row, turnRow.row,
      taperRow.row, segRow.row, handRow.row, opRow.row,
      el('div', { class: 'hint' }, '弹簧 = 圆截面沿螺旋线放样；中径 = 外径 − 线径。锥度让半径沿轴向线性变化（正数向外扩）。')
    );

    modal({ host: 'pm',
      title: '弹簧', body,
      actions: [
        { label: '取消' },
        {
          label: '确定', primary: true, onClick: () => {
            const mean = parseFloat(meanRow.input.value);
            const wire = parseFloat(wireRow.input.value);
            const pitch = parseFloat(pitchRow.input.value);
            const turns = parseFloat(turnRow.input.value);
            const axis: [number, number, number] = [
              parseFloat(dx.input.value) || 0,
              parseFloat(dy.input.value) || 0,
              parseFloat(dz.input.value) || 0,
            ];
            if (!Number.isFinite(mean) || mean <= 0) { notify.err('中径必须为正数'); return false; }
            if (!Number.isFinite(wire) || wire <= 0 || wire >= mean) { notify.err('线径必须为正数且小于中径'); return false; }
            if (!Number.isFinite(pitch) || pitch <= 0) { notify.err('螺距必须为正数'); return false; }
            if (!Number.isFinite(turns) || turns <= 0) { notify.err('圈数必须为正数'); return false; }
            if (Math.hypot(axis[0], axis[1], axis[2]) < 1e-6) { notify.err('轴方向不能为零向量'); return false; }
            const f: SpringFeature = {
              id: newId('f'), type: 'spring', name: app.doc.nextName('spring'),
              params: {
                origin: [
                  parseFloat(ox.input.value) || 0,
                  parseFloat(oy.input.value) || 0,
                  parseFloat(oz.input.value) || 0,
                ],
                axis,
                meanDiameter: mean,
                wireDiameter: wire,
                pitch,
                turns,
                handedness: handRow.select.value as CoilHandedness,
                taperDeg: parseFloat(taperRow.input.value) || 0,
                segmentsPerTurn: Math.round(parseFloat(segRow.input.value) || 24),
                operation: opRow.select.value as BooleanOp,
              },
            };
            app.addFeature(f);
            notify.ok('已添加弹簧');
            return true;
          },
        },
      ],
    });
  },

  /** 涡状线盘簧（发条）：平面阿基米德螺线加厚成闭合带材，再沿法向拉伸 */
  spiral(app: App): void {
    const hasModel = app.hasModel;
    const body = el('div', { class: 'col' });
    const planeRow = selectField('所在平面', 'front', [
      { value: 'front', label: '前视基准面 (XY)' },
      { value: 'top', label: '上视基准面 (XZ)' },
      { value: 'right', label: '右视基准面 (YZ)' },
    ], () => {});
    const rRow = numberField('起始半径', 10, () => {}, { min: 0.2, step: 1, unit: 'mm' });
    const pitchRow = numberField('每圈增量', 4, () => {}, { min: 0.05, step: 0.5, unit: 'mm' });
    const turnRow = numberField('圈数', 5, () => {}, { min: 0.1, step: 1 });
    const thRow = numberField('带材厚度', 1, () => {}, { min: 0.05, step: 0.25, unit: 'mm' });
    const wRow = numberField('带材宽度', 10, () => {}, { min: 0.1, step: 1, unit: 'mm' });
    const handRow = selectField('旋向', 'right', [
      { value: 'right', label: '右旋（逆时针向外）' },
      { value: 'left', label: '左旋（顺时针向外）' },
    ], () => {});
    const symRow = checkField('沿法向对称拉伸', false, () => {});
    const opRow = selectField('操作', hasModel ? 'add' : 'new', [
      ...(hasModel ? [
        { value: 'add', label: '添加（与现有实体合并）' },
        { value: 'cut', label: '切除（从现有实体减去）' },
      ] : []),
      { value: 'new', label: '新建实体' },
    ], () => {});
    body.append(
      planeRow.row, rRow.row, pitchRow.row, turnRow.row,
      thRow.row, wRow.row, handRow.row, symRow.row, opRow.row,
      el('div', { class: 'hint' }, '阿基米德螺线 r = 起始半径 + 每圈增量 × 圈数占比；带材沿径向加厚成闭合轮廓后沿法向拉伸。')
    );

    modal({ host: 'pm',
      title: '涡状线', body,
      actions: [
        { label: '取消' },
        {
          label: '确定', primary: true, onClick: () => {
            const startRadius = parseFloat(rRow.input.value);
            const pitch = parseFloat(pitchRow.input.value);
            const turns = parseFloat(turnRow.input.value);
            const thickness = parseFloat(thRow.input.value);
            const width = parseFloat(wRow.input.value);
            if (!Number.isFinite(startRadius) || startRadius <= 0) { notify.err('起始半径必须为正数'); return false; }
            if (!Number.isFinite(pitch) || pitch <= 0) { notify.err('每圈增量必须为正数'); return false; }
            if (!Number.isFinite(turns) || turns <= 0) { notify.err('圈数必须为正数'); return false; }
            if (!Number.isFinite(thickness) || thickness <= 0) { notify.err('带材厚度必须为正数'); return false; }
            if (!Number.isFinite(width) || width <= 0) { notify.err('带材宽度必须为正数'); return false; }
            const plane = PLANES[planeRow.select.value as 'front' | 'top' | 'right'];
            const f: SpiralFeature = {
              id: newId('f'), type: 'spiral', name: app.doc.nextName('spiral'),
              params: {
                plane,
                startRadius,
                pitch,
                turns,
                thickness,
                width,
                handedness: handRow.select.value as CoilHandedness,
                symmetric: symRow.input.checked,
                operation: opRow.select.value as BooleanOp,
              },
            };
            app.addFeature(f);
            notify.ok('已添加涡状线');
            return true;
          },
        },
      ],
    });
  },

  // ---------------- 基本体 ----------------
  primitive(app: App, kind: PrimitiveFeature['params']['kind']): void {
    const defaults: Record<string, number[]> = {
      box: [20, 20, 20], cylinder: [10, 30], sphere: [15], cone: [12, 0, 25], torus: [20, 5],
    };
    const labels: Record<string, string[]> = {
      box: ['宽 X', '深 Y', '高 Z'], cylinder: ['半径 R', '高 H'], sphere: ['半径 R'],
      cone: ['底半径 R1', '顶半径 R2', '高 H'], torus: ['主半径 R1', '管半径 R2'],
    };
    const defs = defaults[kind];
    const labs = labels[kind];
    const body = el('div', { class: 'col' });
    const inputs: HTMLInputElement[] = [];
    for (let i = 0; i < labs.length; i++) {
      const row = numberField(labs[i], defs[i], () => {}, { unit: 'mm' });
      body.appendChild(row.row);
      inputs.push(row.input);
    }
    modal({ host: 'pm',
      title: `插入 ${kind === 'box' ? '长方体' : kind === 'cylinder' ? '圆柱' : kind === 'sphere' ? '球' : kind === 'cone' ? '圆锥' : '圆环'}`,
      body,
      actions: [
        { label: '取消' },
        {
          label: '确定', primary: true, onClick: () => {
            const dims = inputs.map(inp => parseFloat(inp.value)).filter(Number.isFinite);
            if (dims.length !== labs.length) return false;
            const f: PrimitiveFeature = {
              id: newId('f'), type: 'primitive', name: app.doc.nextName('primitive'),
              params: { kind, dims, operation: 'new' },
            };
            app.addFeature(f);
            return true;
          },
        },
      ],
    });
  },

  // ---------------- 工程特征 ----------------
  fillet(app: App): void {
    const edges = app.selectedEdgeInfos();
    if (!edges.length) { notify.err('请先选中边'); return; }
    const body = el('div', { class: 'col' });
    const r1 = numberField('半径 (mm)', 2, () => {}, { min: 0.01, step: 0.5, unit: 'mm' });
    const r2 = numberField('末端半径 (mm)', 2, () => {}, { min: 0.01, step: 0.5, unit: 'mm' });
    body.append(
      r1.row,
      r2.row,
      el('div', { class: 'hint' }, '两个半径不同时生成**变半径圆角**：半径沿边从起点值线性过渡到末端值；相同则等价于普通定半径圆角。')
    );
    modal({ host: 'pm',
      title: `圆角（已选 ${edges.length} 条边）`,
      body,
      actions: [
        { label: '取消' },
        {
          label: '确定',
          primary: true,
          onClick: () => {
            const a = parseFloat(r1.input.value);
            const b = parseFloat(r2.input.value);
            if (!Number.isFinite(a) || a <= 0) { notify.err('半径必须为正数'); return false; }
            const variable = Number.isFinite(b) && b > 0 && Math.abs(b - a) > 1e-9;
            const f: FilletFeature = {
              id: newId('f'), type: 'fillet', name: app.doc.nextName('fillet'),
              params: { edges: edges.map(makeEdgeRef), radius: a, radius2: variable ? b : undefined },
            };
            app.addFeature(f);
          },
        },
      ],
    });
  },

  /** 缩放（SolidWorks「缩放比例」）：统一或非均匀，以指定点为不动点 */
  scale(app: App): void {
    if (!app.hasModel) { notify.err('请先创建实体'); return; }
    const bb = app.currentModel()?.bbox;
    const c: [number, number, number] = bb
      ? [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2]
      : [0, 0, 0];
    const body = el('div', { class: 'col' });
    const uni = checkField('统一缩放', true, () => {});
    const fRow = numberField('缩放系数', 1.5, () => {}, { min: 0.01, step: 0.1 });
    const fx = numberField('X 系数', 1.5, () => {}, { min: 0.01, step: 0.1 });
    const fy = numberField('Y 系数', 1.5, () => {}, { min: 0.01, step: 0.1 });
    const fz = numberField('Z 系数', 1.5, () => {}, { min: 0.01, step: 0.1 });
    const cx = numberField('中心 X', c[0], () => {}, { step: 1, unit: 'mm' });
    const cy = numberField('中心 Y', c[1], () => {}, { step: 1, unit: 'mm' });
    const cz = numberField('中心 Z', c[2], () => {}, { step: 1, unit: 'mm' });
    body.append(
      uni.row, fRow.row, fx.row, fy.row, fz.row, cx.row, cy.row, cz.row,
      el('div', { class: 'hint' }, '中心点是缩放的不动点（默认取模型包围盒中心，即原地缩放）。非均匀缩放会把圆柱变成椭圆柱——此时「圆柱面」不再存在。')
    );
    modal({ host: 'pm',
      title: '缩放',
      body,
      actions: [
        { label: '取消' },
        {
          label: '确定',
          primary: true,
          onClick: () => {
            const center: [number, number, number] = [
              parseFloat(cx.input.value) || 0,
              parseFloat(cy.input.value) || 0,
              parseFloat(cz.input.value) || 0,
            ];
            const uniform = uni.input.checked;
            const fv = parseFloat(fRow.input.value);
            const fs: [number, number, number] = [
              parseFloat(fx.input.value) || 1,
              parseFloat(fy.input.value) || 1,
              parseFloat(fz.input.value) || 1,
            ];
            if (uniform) {
              if (!Number.isFinite(fv) || fv <= 0) { notify.err('缩放系数必须为正数'); return false; }
            } else if (fs.some((k) => !Number.isFinite(k) || k <= 0)) {
              notify.err('各轴系数必须为正数');
              return false;
            }
            const f: ScaleFeature = {
              id: newId('f'), type: 'scale', name: app.doc.nextName('scale'),
              params: uniform
                ? { center, factor: fv }
                : { center, factor: 1, nonUniform: true, factors: fs },
            };
            app.addFeature(f);
          },
        },
      ],
    });
  },

  /** 分割（SolidWorks「分割」）：用一个基准面把实体切开 */
  split(app: App): void {
    if (!app.hasModel) { notify.err('请先创建实体'); return; }
    const body = el('div', { class: 'col' });
    const planeRow = selectField('切割基准面', 'front', [
      { value: 'front', label: '前视基准面 (XY)' },
      { value: 'top', label: '上视基准面 (XZ)' },
      { value: 'right', label: '右视基准面 (YZ)' },
    ], () => {});
    const offRow = numberField('沿法向偏移 (mm)', 0, () => {}, { step: 1, unit: 'mm' });
    const keepRow = selectField('保留', 'both', [
      { value: 'both', label: '两侧都保留' },
      { value: 'positive', label: '仅法向正侧' },
      { value: 'negative', label: '仅法向负侧' },
    ], () => {});
    body.append(
      planeRow.row, offRow.row, keepRow.row,
      el('div', { class: 'hint' }, '用一张垂直于所选基准面的无限平面切开实体。保留两侧时结果是多个实体（复合体），后续特征会作用在整体上。')
    );
    modal({ host: 'pm',
      title: '分割',
      body,
      actions: [
        { label: '取消' },
        {
          label: '确定',
          primary: true,
          onClick: () => {
            const base = PLANES[planeRow.select.value as 'front' | 'top' | 'right'];
            const off = parseFloat(offRow.input.value) || 0;
            const plane = off ? offsetPlane(base, off) : base;
            const f: SplitFeature = {
              id: newId('f'), type: 'split', name: app.doc.nextName('split'),
              params: { plane, keep: keepRow.select.value as SplitKeep },
            };
            app.addFeature(f);
          },
        },
      ],
    });
  },

  /** 移动/复制实体（SolidWorks「移动/复制实体」）：先绕轴旋转，再平移；可复制多份 */
  moveBody(app: App): void {
    if (!app.hasModel) { notify.err('请先创建实体'); return; }
    const bodyCount = app.modelSummary().solids;
    const body = el('div', { class: 'col' });
    const dx = numberField('平移 X', 0, () => {}, { step: 1, unit: 'mm' });
    const dy = numberField('平移 Y', 0, () => {}, { step: 1, unit: 'mm' });
    const dz = numberField('平移 Z', 50, () => {}, { step: 1, unit: 'mm' });
    const axisRow = selectField('旋转轴', 'z', [
      { value: 'x', label: 'X 轴' },
      { value: 'y', label: 'Y 轴' },
      { value: 'z', label: 'Z 轴' },
    ], () => {});
    const ang = numberField('旋转角度 (°)', 0, () => {}, { step: 15 });
    const copyRow = checkField('复制（保留原件）', false, () => {});
    const cnt = numberField('复制份数', 1, () => {}, { min: 1, step: 1 });
    body.append(dx.row, dy.row, dz.row, axisRow.row, ang.row, copyRow.row, cnt.row);
    // 多实体时让用户挑要搬哪些（默认全选）
    let pick: ReturnType<typeof bodyChecklist> | null = null;
    if (bodyCount > 1) {
      pick = bodyChecklist(bodyCount, () => true);
      body.append(
        el('div', { class: 'field' }, el('label', { text: `作用于哪些实体（共 ${bodyCount} 个）` })),
        ...pick.rows
      );
    }
    body.append(
      el('div', { class: 'hint' }, '先绕所选轴（过原点）旋转，再整体平移。勾选「复制」会保留原件，并沿同一方向生成多份副本（第 i 份施加 i 倍变换）。')
    );
    modal({ host: 'pm',
      title: '移动/复制实体',
      body,
      actions: [
        { label: '取消' },
        {
          label: '确定',
          primary: true,
          onClick: () => {
            const dirs: Record<string, [number, number, number]> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
            const num = (f: { input: HTMLInputElement }) => {
              const v = parseFloat(f.input.value);
              return Number.isFinite(v) ? v : 0;
            };
            const chosen = pick ? pick.selected() : [];
            if (pick && !chosen.length) { notify.err('请至少选择一个实体'); return false; }
            const f: MoveBodyFeature = {
              id: newId('f'), type: 'moveBody', name: app.doc.nextName('moveBody'),
              params: {
                delta: [num(dx), num(dy), num(dz)],
                axisOrigin: [0, 0, 0],
                axisDir: dirs[axisRow.select.value],
                angleDeg: num(ang),
                copy: copyRow.input.checked,
                count: Math.max(1, Math.round(num(cnt))),
                indices: pick && chosen.length < bodyCount ? chosen : undefined,
              },
            };
            app.addFeature(f);
          },
        },
      ],
    });
  },

  /** 删除实体（SolidWorks「删除实体」）：从多实体中移除指定实体 */
  deleteBody(app: App): void {
    const count = app.modelSummary().solids;
    if (count < 1) { notify.err('请先创建实体'); return; }
    const body = el('div', { class: 'col' });
    const list = bodyChecklist(count, () => false);
    body.append(
      ...list.rows,
      el('div', { class: 'hint' }, `当前共 ${count} 个实体。勾选要删除的实体；至少要保留一个。`)
    );
    modal({ host: 'pm',
      title: '删除实体',
      body,
      actions: [
        { label: '取消' },
        {
          label: '确定',
          primary: true,
          onClick: () => {
            const indices = list.selected();
            if (!indices.length) { notify.err('请至少勾选一个要删除的实体'); return false; }
            if (indices.length >= count) { notify.err('不能删除全部实体'); return false; }
            const f: DeleteBodyFeature = {
              id: newId('f'), type: 'deleteBody', name: app.doc.nextName('deleteBody'),
              params: { indices },
            };
            app.addFeature(f);
          },
        },
      ],
    });
  },

  /** 组合（SolidWorks「组合」）：把多个实体按布尔操作合成一个 */
  combine(app: App): void {
    const count = app.modelSummary().solids;
    if (count < 2) { notify.err('组合至少需要 2 个实体（可先用「分割」或「移动/复制」产生多实体）'); return; }
    const body = el('div', { class: 'col' });
    const opts = Array.from({ length: count }, (_, i) => ({ value: String(i), label: `实体 ${i + 1}` }));
    const mainRow = selectField('主体', '0', opts, () => {});
    const tools = bodyChecklist(count, (i) => i > 0);
    const opRow = selectField('操作', 'add', [
      { value: 'add', label: '添加（并集）' },
      { value: 'subtract', label: '减除（差集）' },
      { value: 'common', label: '共同（交集）' },
    ], () => {});
    body.append(
      mainRow.row,
      el('div', { class: 'field' }, el('label', { text: '工具体（可多选）' })),
      ...tools.rows,
      opRow.row,
      el('div', { class: 'hint' }, '把工具体依次与主体做布尔运算；未被选中的实体会原样保留。')
    );
    modal({ host: 'pm',
      title: '组合',
      body,
      actions: [
        { label: '取消' },
        {
          label: '确定',
          primary: true,
          onClick: () => {
            const mainIndex = parseInt(mainRow.select.value, 10);
            const toolIndices = tools.selected().filter((i) => i !== mainIndex);
            if (!toolIndices.length) { notify.err('请至少选择一个工具体（不能与主体相同）'); return false; }
            const f: CombineFeature = {
              id: newId('f'), type: 'combine', name: app.doc.nextName('combine'),
              params: { mainIndex, toolIndices, operation: opRow.select.value as CombineOp },
            };
            app.addFeature(f);
          },
        },
      ],
    });
  },

  chamfer(app: App): void {
    const edges = app.selectedEdgeInfos();
    if (!edges.length) { notify.err('请先选中边'); return; }
    promptNumber('倒角', '距离 (mm)', 2, (d) => {
      const f: ChamferFeature = {
        id: newId('f'), type: 'chamfer', name: app.doc.nextName('chamfer'),
        params: { edges: edges.map(makeEdgeRef), distance: d },
      };
      app.addFeature(f);
    });
  },

  shell(app: App): void {
    const faces = app.selectedFaceInfos();
    if (!faces.length) { notify.err('请先选中要移除的面'); return; }
    promptNumber('抽壳', '厚度 (mm)', 2, (t) => {
      const f: ShellFeature = {
        id: newId('f'), type: 'shell', name: app.doc.nextName('shell'),
        params: { faces: faces.map(makeFaceRef), thickness: t },
      };
      app.addFeature(f);
    });
  },

  // ---------------- 参考几何体 ----------------
  /** 异型孔向导：在选中的平面上打孔（简单孔 / 柱形沉头 / 锥形沉头 / 螺纹） */
  holeWizard(app: App): void {
    const infos = app.selectedFaceInfos();
    if (infos.length !== 1) { notify.info('请先选中一个平面作为孔的放置面'); return; }
    const info = infos[0];
    const plane = planeFromFace(info.centroid as [number, number, number], info.normal as [number, number, number]);

    const body = el('div', { class: 'col' });
    const typeRow = selectField('孔类型', 'simple', [
      { value: 'simple', label: '简单孔' },
      { value: 'counterbore', label: '柱形沉头孔' },
      { value: 'countersink', label: '锥形沉头孔' },
      { value: 'threaded', label: '螺纹孔（装饰）' },
    ], () => {});
    const diaRow = numberField('孔径 Φ', 6, () => {}, { min: 0.1, step: 0.5, unit: 'mm' });
    const throughRow = checkField('通孔（贯穿）', true, () => {});
    const depthRow = numberField('孔深', 10, () => {}, { min: 0.1, step: 1, unit: 'mm' });
    const boreDRow = numberField('沉头直径 Φ', 11, () => {}, { min: 0.1, step: 0.5, unit: 'mm' });
    const boreHRow = numberField('沉头深度', 3, () => {}, { min: 0.1, step: 0.5, unit: 'mm' });
    const sinkDRow = numberField('锥沉直径 Φ', 12, () => {}, { min: 0.1, step: 0.5, unit: 'mm' });
    const sinkHRow = numberField('锥沉深度', 3, () => {}, { min: 0.1, step: 0.5, unit: 'mm' });

    // ---- 孔心定位（面内 U/V 偏移；可选以某草图为孔心）----
    const posURow = numberField('位置 U (相对面中心)', 0, () => {}, { step: 1, unit: 'mm' });
    const posVRow = numberField('位置 V (相对面中心)', 0, () => {}, { step: 1, unit: 'mm' });
    const posUInput = posURow.input;
    const posVInput = posVRow.input;

    // 收集所有草图点作为孔心候选
    const pointOpts: { value: string; label: string; u: number; v: number }[] = [];
    for (const sk of app.doc.sketchFeatures()) {
      const spl = planeOf(sk);
      const s = sk.params.sketch;
      let n = 0;
      for (const id of Object.keys(s.points)) {
        n += 1;
        const pt = s.points[id];
        const world = worldFromSketch(spl, pt.x, pt.y);
        const uv = worldToPlane(plane, world);
        pointOpts.push({ value: `${sk.id}:${id}`, label: `${sk.name} · 点${n} (U=${uv[0].toFixed(1)}, V=${uv[1].toFixed(1)})`, u: uv[0], v: uv[1] });
      }
    }
    const locRow = selectField('定位方式', 'offset', [
      { value: 'offset', label: '面中心 + U/V 偏移' },
      ...(pointOpts.length ? [{ value: 'point', label: '按草图点定位' }] : []),
    ], () => {});
    const ptRow = selectField('草图点', pointOpts[0]?.value ?? '', pointOpts.map(p => ({ value: p.value, label: p.label })), () => {});
    const syncLoc = () => {
      const byPoint = locRow.select.value === 'point';
      ptRow.row.style.display = byPoint ? '' : 'none';
      posURow.row.style.display = byPoint ? 'none' : '';
      posVRow.row.style.display = byPoint ? 'none' : '';
      if (byPoint) {
        const o = pointOpts.find(p => p.value === ptRow.select.value);
        if (o) { posUInput.value = String(o.u); posVInput.value = String(o.v); }
      }
    };
    locRow.select.addEventListener('change', syncLoc);
    ptRow.select.addEventListener('change', syncLoc);

    body.append(typeRow.row, diaRow.row, throughRow.row, depthRow.row, boreDRow.row, boreHRow.row, sinkDRow.row, sinkHRow.row, locRow.row, ptRow.row, posURow.row, posVRow.row);

    const sync = () => {
      const t = typeRow.select.value;
      depthRow.row.style.display = throughRow.input.checked ? 'none' : '';
      const cb = t === 'counterbore';
      const cs = t === 'countersink';
      boreDRow.row.style.display = cb ? '' : 'none';
      boreHRow.row.style.display = cb ? '' : 'none';
      sinkDRow.row.style.display = cs ? '' : 'none';
      sinkHRow.row.style.display = cs ? '' : 'none';
      syncLoc();
    };
    typeRow.select.addEventListener('change', sync);
    throughRow.input.addEventListener('change', sync);
    sync();

    modal({ host: 'pm',
      title: '异型孔向导', body,
      actions: [
        { label: '取消' },
        { label: '确定', primary: true, onClick: () => {
          const diameter = parseFloat(diaRow.input.value);
          if (!Number.isFinite(diameter) || diameter <= 0) return false;
          const f: HoleFeature = {
            id: newId('f'), type: 'hole', name: app.doc.nextName('hole'),
            params: {
              face: makeFaceRef(info),
              plane,
              pos: [parseFloat(posURow.input.value) || 0, parseFloat(posVRow.input.value) || 0],
              type: typeRow.select.value as HoleType,
              diameter,
              depth: parseFloat(depthRow.input.value) || 10,
              through: throughRow.input.checked,
              boreDiameter: parseFloat(boreDRow.input.value) || diameter * 1.8,
              boreDepth: parseFloat(boreHRow.input.value) || 3,
              sinkDiameter: parseFloat(sinkDRow.input.value) || diameter * 2,
              sinkDepth: parseFloat(sinkHRow.input.value) || 3,
            },
          };
          app.addFeature(f);
          notify.ok('已添加孔');
          return true;
        } },
      ],
    });
  },

  /** 基准面：基于选中面或标准基准面创建（偏移 / 平行 / 垂直 / 成角度），并可直接在其上绘制草图 */
  referencePlane(app: App): void {
    const infos = app.selectedFaceInfos();
    const hasFace = infos.length === 1;
    const body = el('div', { class: 'col' });
    const kindRow = selectField('类型', 'offset', [
      { value: 'offset', label: '偏移（沿法向平移）' },
      { value: 'parallel', label: '平行（过指定点）' },
      { value: 'perpendicular', label: '垂直（绕面内轴 90°）' },
      { value: 'angle', label: '成角度（绕面内轴旋转）' },
    ], () => {});
    const baseRow = selectField('基准来源', hasFace ? 'face' : 'front', [
      ...(hasFace ? [{ value: 'face', label: '选中的面' }] : []),
      { value: 'front', label: '前视基准面' },
      { value: 'top', label: '上视基准面' },
      { value: 'right', label: '右视基准面' },
    ], () => {});
    const distRow = numberField('偏移距离', 20, () => {}, { step: 1, unit: 'mm' });
    const pxRow = numberField('过点 X', 0, () => {}, { step: 1, unit: 'mm' });
    const pyRow = numberField('过点 Y', 0, () => {}, { step: 1, unit: 'mm' });
    const pzRow = numberField('过点 Z', 20, () => {}, { step: 1, unit: 'mm' });
    const angRow = numberField('角度 (°)', 45, () => {}, { min: 1, max: 89, step: 1, unit: '°' });
    const axisRow = selectField('旋转轴', 'u', [
      { value: 'u', label: '面内 U 轴' },
      { value: 'v', label: '面内 V 轴' },
    ], () => {});
    const goRow = checkField('创建后立即绘制草图', true, () => {});
    body.append(kindRow.row, baseRow.row, distRow.row, pxRow.row, pyRow.row, pzRow.row, angRow.row, axisRow.row, goRow.row);

    const sync = () => {
      const k = kindRow.select.value;
      distRow.row.style.display = k === 'offset' ? '' : 'none';
      const pt = k === 'parallel';
      pxRow.row.style.display = pt ? '' : 'none';
      pyRow.row.style.display = pt ? '' : 'none';
      pzRow.row.style.display = pt ? '' : 'none';
      angRow.row.style.display = k === 'angle' ? '' : 'none';
      axisRow.row.style.display = k === 'perpendicular' || k === 'angle' ? '' : 'none';
    };
    kindRow.select.addEventListener('change', sync);
    sync();

    modal({ host: 'pm',
      title: '基准面', body,
      actions: [
        { label: '取消' },
        { label: '确定', primary: true, onClick: () => {
          const d = parseFloat(distRow.input.value) || 0;
          const ang = parseFloat(angRow.input.value) || 45;
          const axis = axisRow.select.value as 'u' | 'v';
          const src = baseRow.select.value;
          const kind = kindRow.select.value as ReferencePlaneFeature['params']['kind'];
          const base = src === 'face'
            ? planeFromFace(infos[0].centroid as [number, number, number], infos[0].normal as [number, number, number])
            : PLANES[src as 'front' | 'top' | 'right'];

          let plane: SketchPlane;
          if (kind === 'parallel') {
            plane = parallelPlane(base, [
              parseFloat(pxRow.input.value) || 0,
              parseFloat(pyRow.input.value) || 0,
              parseFloat(pzRow.input.value) || 0,
            ]);
          } else if (kind === 'perpendicular') {
            plane = perpendicularPlane(base, axis);
          } else if (kind === 'angle') {
            plane = angledPlane(base, ang, axis);
          } else {
            plane = offsetPlane(base, d);
          }

          const f: ReferencePlaneFeature = {
            id: newId('f'), type: 'referencePlane', name: app.doc.nextName('referencePlane'),
            params: {
              kind,
              plane,
              distance: kind === 'offset' ? d : undefined,
              angleDeg: kind === 'angle' ? ang : undefined,
              axis: kind === 'perpendicular' || kind === 'angle' ? (axis === 'u' ? base.u : base.v) : undefined,
              baseRef: hasFace && src === 'face' ? makeFaceRef(infos[0]) : undefined,
            },
          };
          app.addFeature(f);
          notify.ok('已创建基准面');
          if (goRow.input.checked) app.startSketch(plane);
          return true;
        } },
      ],
    });
  },

  // ---------------- 工程特征（拔模/筋） ----------------
  /** 拔模：选中要拔模的面，再选中性面（标准基准面或第一个选中面） */
  draft(app: App): void {
    const faces = app.selectedFaceInfos();
    if (!faces.length) { notify.err('请先选中要拔模的面'); return; }
    const body = el('div', { class: 'col' });
    const neutralRow = selectField('中性面', 'front', [
      { value: 'front', label: '前视基准面 (Z=0)' },
      { value: 'top', label: '上视基准面 (Y=0)' },
      { value: 'right', label: '右视基准面 (X=0)' },
      { value: 'sel', label: `选中的第一个面` },
    ], () => {});
    const angRow = numberField('拔模角 (°)', 5, () => {}, { min: 0, max: 89, step: 1, unit: '°' });
    const revRow = checkField('反向（向内/向外互换）', false, () => {});
    body.append(neutralRow.row, angRow.row, revRow.row);
    modal({ host: 'pm',
      title: '拔模', body,
      actions: [
        { label: '取消' },
        { label: '确定', primary: true, onClick: () => {
          const angle = parseFloat(angRow.input.value);
          if (!Number.isFinite(angle) || angle <= 0) return false;
          const src = neutralRow.select.value;
          let neutral: { point: [number, number, number]; normal: [number, number, number] };
          if (src === 'sel') {
            neutral = { point: faces[0].centroid as [number, number, number], normal: faces[0].normal as [number, number, number] };
          } else {
            const pl = PLANES[src as 'front' | 'top' | 'right'];
            neutral = { point: pl.origin, normal: pl.normal };
          }
          const f: DraftFeature = {
            id: newId('f'), type: 'draft', name: app.doc.nextName('draft'),
            params: {
              neutralFace: neutral,
              draftFaces: faces.map(makeFaceRef),
              angleDeg: angle,
              reverse: revRow.input.checked,
            },
          };
          app.addFeature(f);
          notify.ok('已添加拔模');
          return true;
        } },
      ],
    });
  },

  /** 筋：把草图的开口轮廓加厚成薄壁 */
  rib(app: App): void {
    const sketches = app.doc.sketchFeatures();
    if (!sketches.length) { notify.err('没有可用草图'); return; }
    const sketchId = app.editingSketch?.id ?? sketches[sketches.length - 1].id;
    const body = el('div', { class: 'col' });
    const thRow = numberField('厚度', 2, () => {}, { min: 0.1, step: 0.5, unit: 'mm' });
    const dpRow = numberField('深度', 10, () => {}, { min: 0.1, step: 1, unit: 'mm' });
    const symRow = checkField('对称拉伸', false, () => {});
    body.append(thRow.row, dpRow.row, symRow.row);
    modal({ host: 'pm',
      title: '筋', body,
      actions: [
        { label: '取消' },
        { label: '确定', primary: true, onClick: () => {
          const th = parseFloat(thRow.input.value);
          const dp = parseFloat(dpRow.input.value);
          if (!Number.isFinite(th) || th <= 0 || !Number.isFinite(dp) || dp <= 0) return false;
          const f: RibFeature = {
            id: newId('f'), type: 'rib', name: app.doc.nextName('rib'),
            params: { sketchId, thickness: th, depth: dp, symmetric: symRow.input.checked },
          };
          app.addFeature(f);
          notify.ok('已添加筋');
          return true;
        } },
      ],
    });
  },

  // ---------------- 阵列 ----------------
  linearPattern(app: App): void {
    const body = el('div', { class: 'col' });
    const dirRow = numberField('方向 X', 1, () => {}, {});
    const dirY = numberField('方向 Y', 0, () => {}, {});
    const dirZ = numberField('方向 Z', 0, () => {}, {});
    const spRow = numberField('间距', 20, () => {}, { unit: 'mm' });
    const cntRow = numberField('数量', 3, () => {}, { min: 2, step: 1 });
    body.append(dirRow.row, dirY.row, dirZ.row, spRow.row, cntRow.row);
    modal({ host: 'pm',
      title: '线性阵列', body,
      actions: [
        { label: '取消' },
        { label: '确定', primary: true, onClick: () => {
          const d = [parseFloat(dirRow.input.value), parseFloat(dirY.input.value), parseFloat(dirZ.input.value)];
          const sp = parseFloat(spRow.input.value);
          const cnt = parseInt(cntRow.input.value, 10);
          if (!Number.isFinite(sp) || cnt < 2) return false;
          const f: LinearPatternFeature = {
            id: newId('f'), type: 'linearPattern', name: app.doc.nextName('linearPattern'),
            params: { direction: d as [number, number, number], spacing: sp, count: cnt },
          };
          app.addFeature(f);
          return true;
        } },
      ],
    });
  },

  circularPattern(app: App): void {
    const body = el('div', { class: 'col' });
    const axO = numberField('轴原点 X', 0, () => {}, {});
    const axOY = numberField('轴原点 Y', 0, () => {}, {});
    const axOZ = numberField('轴原点 Z', 0, () => {}, {});
    const axD = numberField('轴方向 X', 0, () => {}, {});
    const axDY = numberField('轴方向 Y', 0, () => {}, {});
    const axDZ = numberField('轴方向 Z', 1, () => {}, {});
    const cntRow = numberField('数量', 4, () => {}, { min: 2, step: 1 });
    const angRow = numberField('总角度 (°)', 360, () => {}, {});
    body.append(axO.row, axOY.row, axOZ.row, axD.row, axDY.row, axDZ.row, cntRow.row, angRow.row);
    modal({ host: 'pm',
      title: '圆周阵列', body,
      actions: [
        { label: '取消' },
        { label: '确定', primary: true, onClick: () => {
          const origin: [number, number, number] = [parseFloat(axO.input.value), parseFloat(axOY.input.value), parseFloat(axOZ.input.value)];
          const dir: [number, number, number] = [parseFloat(axD.input.value), parseFloat(axDY.input.value), parseFloat(axDZ.input.value)];
          const cnt = parseInt(cntRow.input.value, 10);
          const ang = parseFloat(angRow.input.value);
          if (cnt < 2) return false;
          const f: CircularPatternFeature = {
            id: newId('f'), type: 'circularPattern', name: app.doc.nextName('circularPattern'),
            params: { axisOrigin: origin, axisDir: dir, count: cnt, totalAngleDeg: ang, equalSpacing: true },
          };
          app.addFeature(f);
          return true;
        } },
      ],
    });
  },

  mirror(app: App): void {
    const body = el('div', { class: 'col' });
    const pRow = numberField('平面上一点 X', 0, () => {}, {});
    const pY = numberField('Y', 0, () => {}, {});
    const pZ = numberField('Z', 0, () => {}, {});
    const nRow = numberField('法向 X', 0, () => {}, {});
    const nY = numberField('法向 Y', 0, () => {}, {});
    const nZ = numberField('法向 Z', 1, () => {}, {});
    body.append(pRow.row, pY.row, pZ.row, nRow.row, nY.row, nZ.row);
    modal({ host: 'pm',
      title: '镜像', body,
      actions: [
        { label: '取消' },
        { label: '确定', primary: true, onClick: () => {
          const pt: [number, number, number] = [parseFloat(pRow.input.value), parseFloat(pY.input.value), parseFloat(pZ.input.value)];
          const n: [number, number, number] = [parseFloat(nRow.input.value), parseFloat(nY.input.value), parseFloat(nZ.input.value)];
          const f: MirrorFeature = {
            id: newId('f'), type: 'mirror', name: app.doc.nextName('mirror'),
            params: { planePoint: pt, planeNormal: n },
          };
          app.addFeature(f);
          return true;
        } },
      ],
    });
  },

  // ---------------- 装配 ----------------
  insertComponent(app: App): void {
    const a = app.ensureAssembly();
    a.insertFromDocument(app.doc.clone(), `零件${a.components.length + 1}`);
    app.syncAssemblyScene();
    notify.ok('已插入当前零件');
  },

  newComponent(app: App): void {
    const a = app.ensureAssembly();
    const doc = new CadDocument();
    a.addComponent(doc, `零件${a.components.length + 1}`);
    app.syncAssemblyScene();
    notify.ok('新建零件已添加');
  },

  deleteComponent(app: App): void {
    const a = app.ensureAssembly();
    if (!a.components.length) { notify.info('没有组件'); return; }
    const c = a.components[a.components.length - 1];
    confirmDialog('删除组件', `确定删除 "${c.name}" 吗？`, () => {
      a.removeComponent(c.id);
      app.syncAssemblyScene();
      notify.ok('组件已删除');
    });
  },

  mate(app: App): void {
    const a = app.ensureAssembly();
    if (a.components.length < 2) { notify.info('至少需要两个组件'); return; }
    const types = ['coincident', 'concentric', 'distance', 'parallel', 'perpendicular', 'angle'] as const;
    const labels: Record<string, string> = { coincident: '重合', concentric: '同心', distance: '距离', parallel: '平行', perpendicular: '垂直', angle: '角度' };
    const picks = app.assemblyPicks;
    const picked = picks.length === 2;
    const bothAxis = picked && !!picks[0].isAxis && !!picks[1].isAxis;
    const smartType = bothAxis ? 'concentric' : 'coincident';
    const body = el('div', { class: 'col' });
    const sel = selectField('配合类型', smartType, types.map(t => ({ value: t, label: labels[t] })), () => {});
    const autoFace = picked && picks[0].comp !== picks[1].comp;
    const pickSummary = picked
      ? picks.map(p => `${a.getComponent(p.comp)?.name ?? '?'}·${mateRefLabel(p)}`).join('  ↔  ')
      : '';
    const refModeRow = selectField('参考来源', autoFace ? 'pick' : 'center', [
      ...(picked ? [{ value: 'pick', label: `视口拾取（${pickSummary}）` }] : []),
      { value: 'center', label: '组件包围盒中心（默认）' },
    ], () => {});
    const c1Row = selectField('组件 1', a.components[0].id, a.components.map(c => ({ value: c.id, label: c.name })), () => {});
    const c2Row = selectField('组件 2', a.components[1]?.id ?? a.components[0].id, a.components.map(c => ({ value: c.id, label: c.name })), () => {});
    const valRow = numberField('数值', 0, () => {}, { unit: 'mm / °' });
    const hint = el('div', { class: 'hint' }, picks.length === 0 ? '提示：先在视口点选两个参考（平面/棱边/圆柱面）再执行本命令' : '');
    body.append(sel.row, refModeRow.row, c1Row.row, c2Row.row, valRow.row, hint);
    modal({ host: 'pm',
      title: '添加配合', body,
      actions: [
        { label: '取消' },
        { label: '确定', primary: true, onClick: () => {
          const type = sel.select.value as any;
          const usePick = refModeRow.select.value === 'pick';
          let refA: MateRef;
          let refB: MateRef;
          if (usePick && picked) {
            [refA, refB] = [picks[0], picks[1]];
          } else {
            const c1 = a.getComponent(c1Row.select.value) ?? a.components[0];
            const c2 = a.getComponent(c2Row.select.value) ?? a.components[1];
            const center = (c: typeof c1): MateRef => {
              const bb = c.bbox ?? { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
              return {
                comp: c.id,
                localPoint: [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2],
                localDir: [0, 0, 1],
              };
            };
            refA = center(c1);
            refB = center(c2);
          }
          const value = parseFloat(valRow.input.value);
          a.mates.push({
            id: newId('m'), type, name: `${labels[type]}${a.mates.length + 1}`,
            a: refA, b: refB,
            value: Number.isFinite(value) ? value : undefined,
          });
          app.clearAssemblyPicks();
          a.solve();
          app.syncAssemblyScene();
          notify.ok('配合已添加');
          return true;
        } },
      ],
    });
  },

  solveAssembly(app: App): void {
    const a = app.ensureAssembly();
    const r = a.solve();
    app.syncAssemblyScene();
    notify.info(`配合求解完成：${r.iterations} 轮，残差 ${r.residual.toExponential(1)}`);
  },

  toggleFixed(app: App): void {
    const a = app.ensureAssembly();
    if (!a.components.length) { notify.info('没有组件'); return; }
    const c = a.components[a.components.length - 1];
    c.fixed = !c.fixed;
    app.syncAssemblyScene();
    notify.ok(c.fixed ? '已固定' : '已浮动');
  },

  interference(app: App): void {
    const a = app.ensureAssembly();
    a.checkInterference().then((res) => {
      if (!res.length) { notify.ok('无干涉'); return; }
      tableModal('干涉检查', ['零件A', '零件B', `干涉体积 (${app.unitSystem === 'IPS' ? 'in³' : app.unitSystem === 'CGS' ? 'cm³' : 'mm³'})`], res.map(r => [r.a, r.b, formatVolume(r.volume, app.unitSystem)]));
    }).catch((e) => notify.err(`干涉检查失败：${(e as Error).message}`));
  },

  explodeDialog(app: App): void {
    const a = app.ensureAssembly();
    promptNumber('爆炸视图', '爆炸距离 (mm)', a.explodeAmount, (v) => {
      a.setExplode(v);
      app.syncAssemblyScene();
    });
  },

  // ---------------- 工程图 ----------------
  generateDrawing(app: App, kinds: ViewKind[]): void {
    app.generateDrawing(kinds);
  },

  addDrawingView(app: App, kind: ViewKind): void {
    app.addDrawingView(kind);
  },

  drawingDimension(app: App): void {
    app.toggleDimensionMode();
  },

  clearDrawingDims(app: App): void {
    app.clearDrawingDims();
  },

  toggleHiddenLines(app: App): void {
    const d = app.drawing;
    if (!d) return;
    d.showHidden = !d.showHidden;
    app.refreshDrawing();
    notify.info(d.showHidden ? '隐藏线：显示' : '隐藏线：隐藏');
  },

  showBOM(app: App): void {
    const d = app.drawing;
    if (!d) { notify.info('没有工程图'); return; }
    tableModal('明细表', ['视图', '边数', '隐藏线'], d.views.map((v, i) => [v.label, String(v.edges.length), String(v.edges.filter(e => e.hidden).length)]));
  },

  exportDrawingSVG(app: App): void {
    const d = app.drawing;
    if (!d) { notify.err('没有工程图'); return; }
    const svg = d.toSVG();
    download(svg, 'drawing.svg', 'image/svg+xml');
    notify.ok('SVG 已导出');
  },

  exportDrawingPNG(app: App): void {
    app.exportDrawingPNG().catch((e) => notify.err(`PNG 导出失败：${(e as Error).message}`));
  },

  autoDimensionDrawing(app: App): void {
    const d = app.drawing;
    if (!d || !d.views.length) { notify.info('请先生成工程图视图'); return; }
    const body = el('div', { class: 'col' });
    const modeRow = selectField('标注范围', 'overall', [
      { value: 'overall', label: '总宽 / 总高' },
      { value: 'all', label: '总宽高 + 各直线边' },
    ], () => {});
    body.appendChild(modeRow.row);
    modal({ host: 'pm',
      title: '自动标注',
      body,
      actions: [
        { label: '取消' },
        { label: '确定', primary: true, onClick: () => {
          app.autoDimensionDrawing(modeRow.select.value as 'overall' | 'all');
          return true;
        } },
      ],
    });
  },

  autoHoleDimension(app: App): void {
    app.autoHoleDimensionDrawing();
  },

  dimensionTolerance(app: App): void {
    const d = app.drawing;
    const items: { viewId: string; dim: DimAnnotation; label: string }[] = [];
    if (d) {
      for (const v of d.views) {
        v.dims.forEach((dim, i) => {
          items.push({
            viewId: v.id,
            dim,
            label: `${v.label} · ${i + 1} 号标注：${d.dimensionValue(v, dim).toFixed(2)} mm`,
          });
        });
      }
    }
    if (!items.length) {
      notify.info('没有可编辑的尺寸标注（先标注或自动标注）');
      return;
    }
    const body = el('div', { class: 'col' });
    const selDim = selectField('标注', `${items[0].viewId}::${items[0].dim.id}`, items.map((it) => ({
      value: `${it.viewId}::${it.dim.id}`,
      label: it.label,
    })), () => {});
    const symRow = numberField('对称公差 ±', 0, () => {}, { min: 0, step: 0.01, unit: 'mm' });
    const upRow = numberField('上偏差', 0, () => {}, { step: 0.01, unit: 'mm' });
    const loRow = numberField('下偏差', 0, () => {}, { step: 0.01, unit: 'mm' });
    const preRow = textField('前缀（如 φ / ⌀）', '', () => {});
    body.append(selDim.row, symRow.row, upRow.row, loRow.row, preRow.row, el('div', { class: 'hint' }, '说明：± > 0 时按对称公差渲染；否则用上/下偏差渲染成上下堆叠。清空前缀可移除。'));
    modal({ host: 'pm',
      title: '尺寸公差',
      body,
      actions: [
        { label: '取消' },
        { label: '确定', primary: true, onClick: () => {
          const [viewId, dimId] = selDim.select.value.split('::');
          const sym = parseFloat((symRow.input as HTMLInputElement).value) || 0;
          const up = parseFloat((upRow.input as HTMLInputElement).value) || 0;
          const lo = parseFloat((loRow.input as HTMLInputElement).value) || 0;
          const prefix = (preRow.input as HTMLInputElement).value;
          app.applyDrawingDimMeta(viewId, dimId, {
            prefix,
            tolerance: sym > 0 ? { upper: sym, lower: -sym } : { upper: up, lower: lo },
          });
          return true;
        } },
      ],
    });
  },

  gdt(app: App): void {
    const d = app.drawing;
    if (!d || !d.views.length) {
      notify.info('请先生成工程图视图');
      return;
    }
    const body = el('div', { class: 'col' });
    const viewRow = selectField('视图', d.views[0].id, d.views.map((v) => ({ value: v.id, label: v.label })), () => {});
    const symRow = selectField('形位公差', 'position', Object.entries(GDT_LABEL).map(([k, label]) => ({
      value: k,
      label,
    })), () => {});
    const tolRow = numberField('公差值', 0.05, () => {}, { min: 0, step: 0.01, unit: 'mm' });
    const datRow = textField('基准（如 A / A-B）', 'A', () => {});
    const diaRow = checkField('标注 ⌀（尺寸要素为孔径）', false, () => {});
    body.append(viewRow.row, symRow.row, tolRow.row, datRow.row, diaRow.row);
    modal({ host: 'pm',
      title: '形位公差标注',
      body,
      actions: [
        { label: '取消' },
        { label: '确定', primary: true, onClick: () => {
          const v = d.views.find((x) => x.id === viewRow.select.value);
          if (v) {
            d.addGdt(v.id, symRow.select.value as GdtSymbol, parseFloat((tolRow.input as HTMLInputElement).value) || 0, {
              datum: (datRow.input as HTMLInputElement).value || undefined,
              diameter: (diaRow.input as HTMLInputElement).checked,
            });
            app.refreshDrawing();
            notify.ok('已添加形位公差标注（右键可删除）');
          }
          return true;
        } },
      ],
    });
  },

  toggleBOM(app: App): void {
    app.toggleDrawingBOM();
  },

  sheetSettings(app: App): void {
    const d = app.drawing;
    if (!d) { notify.info('没有工程图'); return; }
    const s = d.sheet;
    const body = el('div', { class: 'col' });
    const t = textField('名称', s.title, () => {});
    const c = textField('图号', s.code, () => {});
    const m = textField('材料', s.material, () => {});
    body.append(t.row, c.row, m.row);
    modal({ host: 'pm',
      title: '图纸属性', body,
      actions: [
        { label: '取消' },
        { label: '确定', primary: true, onClick: () => {
          s.title = (t.input as HTMLInputElement).value;
          s.code = (c.input as HTMLInputElement).value;
          s.material = (m.input as HTMLInputElement).value;
          app.refreshDrawing();
          return true;
        } },
      ],
    });
  },

  // ---------------- 评估 ----------------
  modelInfo(app: App): void {
    const cur = app.currentModel();
    if (!cur) { notify.info('没有模型'); return; }
    const st = cur.stats;
    const sys = app.unitSystem;
    tableModal('模型信息', ['项目', '数值'], [
      ['特征数', String(app.doc.features.length)],
      ['面数', String(st.faces)],
      ['边数', String(st.edges)],
      ['体积', formatVolume(st.volume, sys)],
      ['表面积', formatArea(st.area, sys)],
    ]);
  },

  geometryCheck(app: App): void {
    if (!app.hasModel) { notify.err('没有实体'); return; }
    const errs = app.doc.features.filter(f => f.error);
    if (errs.length) {
      tableModal('几何检查', ['特征', '错误'], errs.map(f => [f.name, f.error ?? '']));
    } else {
      notify.ok('几何检查通过');
    }
  },

  // ---------------- 文件 ----------------
  newProject(app: App): void {
    confirmDialog('新建项目', '确定要清空当前文档吗？未保存的数据将丢失。', () => {
      app.pushUndo();
      app.doc = new CadDocument();
      app.assembly = null;
      app.drawing = null;
      app.rebuild({ fit: true });
      notify.ok('新项目已创建');
    });
  },
  // ---------------- 参数化（参考 FreeCAD Expressions） ----------------
  /** 参数表：全局命名参数 + 表达式，一处改动驱动整棵特征树 */
  parameterTable(app: App): void {
    const host = el('div', { class: 'col' });
    const IDENT = /^[A-Za-z_\u3400-\u4dbf\u4e00-\u9fff][A-Za-z0-9_\u3400-\u4dbf\u4e00-\u9fff]*$/;

    const render = () => {
      clear(host);
      const rows = app.paramRows();

      // ---- 现有参数表 ----
      const table = el('table', { class: 'expr-table' });
      table.appendChild(
        el('thead', {}, el('tr', {},
          el('th', { text: '名称' }),
          el('th', { text: '表达式' }),
          el('th', { text: '值' }),
          el('th', { text: '' }),
        ))
      );
      const tbody = el('tbody');
      for (const r of rows) {
        const nameCell = el('td', {},
          el('span', { class: 'mono', text: r.name }),
          r.comment ? el('div', { class: 'hint', text: r.comment }) : null,
        );
        const exprInput = el('input', { class: 'inp wide', type: 'text', value: r.expr }) as HTMLInputElement;
        exprInput.addEventListener('change', () => {
          if (!exprInput.value.trim()) return;
          app.setParam(r.name, exprInput.value);
          render();
        });
        const valueCell = el('td', { class: 'mono' });
        if (r.error) valueCell.appendChild(el('span', { class: 'tag r', text: '错误' }));
        else valueCell.appendChild(el('span', { text: r.value === undefined ? '—' : fmt(r.value) }));
        if (r.error) valueCell.title = r.error;
        const del = el('button', { class: 'x', type: 'button', text: '×', title: '删除参数' });
        del.addEventListener('click', () => { app.removeParam(r.name); render(); });
        tbody.appendChild(el('tr', { class: r.error ? 'err' : '' }, nameCell, el('td', {}, exprInput), valueCell, el('td', {}, del)));
      }
      if (!rows.length) {
        tbody.appendChild(el('tr', {}, el('td', { colspan: 4 }, el('div', { class: 'hint', text: '还没有参数。在下面添加，例如「板厚 = 8」。' }))));
      }
      table.appendChild(tbody);
      host.appendChild(table);

      // ---- 新增 ----
      const nameIn = el('input', { class: 'inp', type: 'text', placeholder: '名称（如 板厚）' }) as HTMLInputElement;
      const exprIn = el('input', { class: 'inp wide', type: 'text', placeholder: '表达式（如 8 或 板厚*2）' }) as HTMLInputElement;
      const preview = el('span', { class: 'hint', text: '' });
      const refreshPreview = () => {
        const v = exprIn.value.trim();
        if (!v) { preview.textContent = ''; return; }
        const r = app.previewExpr(v);
        preview.textContent = r.ok ? `= ${fmt(r.value!)}` : `✗ ${r.message}`;
        preview.style.color = r.ok ? '' : 'var(--err,#c0392b)';
      };
      exprIn.addEventListener('input', refreshPreview);

      const add = el('button', { class: 'btn primary', type: 'button', text: '添加参数' });
      add.addEventListener('click', () => {
        const n = nameIn.value.trim();
        const e = exprIn.value.trim();
        if (!n || !e) { notify.err('请填写参数名与表达式'); return; }
        if (!IDENT.test(n)) { notify.err('参数名只能用字母/中文/数字/下划线，且不能以数字开头'); return; }
        app.setParam(n, e);
        notify.ok(`已设置参数 ${n}`);
        render();
      });
      nameIn.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') exprIn.focus(); });
      exprIn.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') add.click(); });

      host.appendChild(section('新增参数', el('div', { class: 'col' },
        el('div', { class: 'field' }, el('label', { text: '名称' }), el('div', { class: 'val' }, nameIn)),
        el('div', { class: 'field' }, el('label', { text: '表达式' }), el('div', { class: 'val' }, exprIn, preview)),
        el('div', { class: 'field' }, el('label', { text: '' }), el('div', { class: 'val' }, add)),
      )));

      // ---- 可用引用 ----
      const refs = app.referenceCandidates();
      if (refs.length) {
        const list = el('div', { class: 'list' });
        for (const c of refs.slice(0, 40)) {
          const item = el('div', { class: 'list-item' },
            el('span', { class: 'mono', text: c.ref }),
            el('span', { class: 'tag', text: c.label.split(' = ')[1] ?? '' }),
          );
          item.addEventListener('click', () => { exprIn.value = (exprIn.value ? exprIn.value + ' + ' : '') + c.ref; refreshPreview(); exprIn.focus(); });
          list.appendChild(item);
        }
        host.appendChild(section(`可用引用（点击插入，共 ${refs.length} 个）`, list, false));
      }

      host.appendChild(el('div', { class: 'hint' },
        '在任意数值参数里写以 = 开头的公式即可引用这里的参数；也能引用其他特征的属性（如 拉伸1.distance、长方体1.dims[0]）。'
        + '支持 + - * / % ^、比较与逻辑、sin/cos/sqrt/min/max/round 等函数、pi/e 常量，以及紧贴数字的单位（10mm、2in、30deg）。'));
    };

    render();
    const off = app.on('params', render);
    modal({ host: 'pm',
      title: '参数表 · 全局参数与表达式',
      body: host,
      actions: [{ label: '关闭', primary: true }],
      width: 660,
      onClose: off,
    });
  },

  /** 给「当前特征」的某个数值参数绑定表达式 */
  featureExpression(app: App): void {
    const sel = app.doc.features.length ? app.doc.features[app.doc.features.length - 1] : null;
    if (!sel) { notify.info('请先创建一个特征'); return; }
    const host = el('div', { class: 'col' });

    const render = () => {
      clear(host);
      const params = app.featureNumericParams(sel.id);
      if (!params.length) {
        host.appendChild(el('div', { class: 'hint', text: `「${sel.name}」没有可参数化的数值参数。` }));
        return;
      }
      const select = el('select', { class: 'inp' },
        ...params.map((p, i) => el('option', { value: p.path, text: `${p.label}（${p.path}） = ${fmt(p.value)}`, selected: i === 0 })),
      ) as HTMLSelectElement;
      const exprIn = el('input', { class: 'inp wide', type: 'text', placeholder: '表达式，如 板厚*2' }) as HTMLInputElement;
      const preview = el('span', { class: 'hint', text: '' });
      const refresh = () => {
        const v = exprIn.value.trim();
        if (!v) { preview.textContent = ''; return; }
        const r = app.previewExpr(v);
        preview.textContent = r.ok ? `= ${fmt(r.value!)}` : `✗ ${r.message}`;
        preview.style.color = r.ok ? '' : 'var(--err,#c0392b)';
      };
      exprIn.addEventListener('input', refresh);

      const apply = el('button', { class: 'btn primary', type: 'button', text: '绑定表达式' });
      apply.addEventListener('click', () => {
        const path = select.value;
        const v = exprIn.value.trim();
        if (!v) { notify.err('请填写表达式'); return; }
        const r = app.previewExpr(v);
        if (!r.ok) { notify.err(`表达式有误：${r.message}`); return; }
        app.setFeatureExpression(sel.id, path, v);
        notify.ok(`已绑定 ${sel.name}.${path} = ${v}`);
        render();
      });

      host.appendChild(section('绑定新表达式', el('div', { class: 'col' },
        el('div', { class: 'field' }, el('label', { text: '参数' }), el('div', { class: 'val' }, select)),
        el('div', { class: 'field' }, el('label', { text: '表达式' }), el('div', { class: 'val' }, exprIn, preview)),
        el('div', { class: 'field' }, el('label', { text: '' }), el('div', { class: 'val' }, apply)),
      )));

      const bound = app.featureExpressionRows(sel.id);
      const list = el('div', { class: 'list' });
      for (const b of bound) {
        const item = el('div', { class: 'list-item' },
          el('span', { text: b.label }),
          el('span', { class: 'mono', text: b.expr }),
          b.error
            ? el('span', { class: 'tag r', text: '错误' })
            : el('span', { class: 'tag g', text: b.value === undefined ? '—' : fmt(b.value) }),
        );
        if (b.error) item.title = b.error;
        const del = el('button', { class: 'x', type: 'button', text: '×', title: '解除绑定' });
        del.addEventListener('click', () => { app.removeFeatureExpression(sel.id, b.path); render(); });
        item.appendChild(del);
        list.appendChild(item);
      }
      host.appendChild(section(`已绑定表达式（${bound.length}）`, bound.length ? list
        : el('div', { class: 'hint', text: '该特征还没有表达式，参数取字面值。' })));

      const refs = app.referenceCandidates();
      if (refs.length) {
        const rl = el('div', { class: 'list' });
        for (const c of refs.slice(0, 40)) {
          const item = el('div', { class: 'list-item' }, el('span', { class: 'mono', text: c.ref }), el('span', { class: 'tag', text: c.label.split(' = ')[1] ?? '' }));
          item.addEventListener('click', () => { exprIn.value = (exprIn.value ? exprIn.value + ' + ' : '') + c.ref; refresh(); exprIn.focus(); });
          rl.appendChild(item);
        }
        host.appendChild(section('可用引用（点击插入）', rl, false));
      }

      host.appendChild(el('div', { class: 'hint' },
        `把「${sel.name}」的参数交给公式驱动后，改公式或改全局参数都会自动重算几何。`));
    };

    render();
    const off = app.on('params', render);
    modal({ host: 'pm',
      title: `表达式 · ${sel.name}`,
      body: host,
      actions: [{ label: '关闭', primary: true }],
      width: 620,
      onClose: off,
    });
  },
};

/** 数值显示：最多两位小数 */
function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function sketchPlaneFromNormal(normal: [number, number, number], centroid: [number, number, number]) {
  const n = normalize(normal);
  let ux: [number, number, number] = [0, 0, 1];
  const dot = ux[0] * n[0] + ux[1] * n[1] + ux[2] * n[2];
  if (Math.abs(dot) > 0.98) ux = [0, 1, 0];
  const u = normalize(cross(ux, n));
  const v = normalize(cross(n, u));
  return { origin: centroid, u, v, normal: n, ref: 'custom' as const };
}

function normalize(v: [number, number, number]): [number, number, number] {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}
function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * 「实体 N」多选清单。返回每行元素（供 append 进 modal）与已勾选下标读取器。
 * 实体顺序与内核 `bodiesOf` 的展开顺序一致（0 起）。
 */
function bodyChecklist(count: number, initial: (i: number) => boolean) {
  const items = Array.from({ length: count }, (_, i) => checkField(`实体 ${i + 1}`, initial(i), () => {}));
  return {
    rows: items.map((it) => it.row),
    selected: () => items.map((it, i) => (it.input.checked ? i : -1)).filter((i) => i >= 0),
  };
}

function textField(label: string, value: string, onChange: (v: string) => void) {
  const input = el('input', { class: 'inp wide', type: 'text', value }) as HTMLInputElement;
  input.addEventListener('change', () => onChange(input.value));
  const row = el('div', { class: 'field' }, el('label', { text: label }), el('div', { class: 'val' }, input));
  return { row, input };
}
