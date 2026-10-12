/**
 * Ribbon 工具栏 —— 数据驱动的命令定义。
 */
import { el, clear } from './dom';
import { icon } from './icons';
import type { App } from '../app/app';
import { notify } from './toast';
import { featureDialogs } from './dialogs';
import { openAiModeling, openAiHelp } from './aipanel';

export type CmdId = string;

export interface RButton {
  id: CmdId;
  label: string;
  icon: string;
  big?: boolean;
  tip?: string;
  run: (app: App) => void;
  enabled?: (app: App) => boolean;
  active?: (app: App) => boolean;
}

export type RItem = RButton | 'sep';

export interface RGroup {
  title: string;
  items: RItem[];
}

export interface RTab {
  id: string;
  label: string;
  groups: RGroup[];
}

const D = featureDialogs;

export function buildTabs(): RTab[] {
  return [
    {
      id: 'ai',
      label: 'AI',
      groups: [
        {
          title: '自然语言建模',
          items: [
            {
              id: 'ai.model',
              label: 'AI 建模',
              icon: 'ai',
              big: true,
              run: (a) => openAiModeling(a, { mode: 'create' }),
              tip: '用中文描述零件（如「60x40x10 的长方体，中心开 Φ16 通孔，四角倒圆角 R5」），自动解析成特征树并建模',
            },
            {
              id: 'ai.edit',
              label: 'AI 编辑',
              icon: 'ai',
              big: true,
              run: (a) => openAiModeling(a, { mode: 'edit' }),
              enabled: (a) => a.doc.features.length > 0,
              tip: '在现有模型上继续用中文改：追加特征 / 改尺寸 / 删特征（如「上面加一个圆柱」「把高改成 20」「删掉圆角」）',
            },
            {
              id: 'ai.hint',
              label: '语法帮助',
              icon: 'aiPrompt',
              run: () => openAiHelp(),
              tip: '查看本地解析器支持的句式与关键词',
            },
          ],
        },
      ],
    },
    {
      id: 'sketch',
      label: '草图',
      groups: [
        {
          title: '草图',
          items: [
            { id: 'sk.front', label: '草图绘制', icon: 'sketch', big: true, run: (a) => a.startSketch('front'), enabled: (a) => a.mode !== 'sketch' },
            { id: 'sk.top', label: '上视基准面', icon: 'originPlane', run: (a) => a.startSketch('top'), enabled: (a) => a.mode !== 'sketch' },
            { id: 'sk.right', label: '右视基准面', icon: 'plane', run: (a) => a.startSketch('right'), enabled: (a) => a.mode !== 'sketch' },
            { id: 'sk.face', label: '在面上草图', icon: 'modelView', run: (a) => D.sketchOnFace(a), enabled: (a) => a.mode === 'model' && a.selection.faces.length === 1 },
          ],
        },
        {
          title: '实体',
          items: [
            { id: 'sk.line', label: '直线', icon: 'line', big: true, run: (a) => a.setSketchTool?.('line'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'line' },
            { id: 'sk.rect', label: '矩形', icon: 'rectangle', big: true, run: (a) => a.setSketchTool?.('rect'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'rect' },
            { id: 'sk.circle', label: '圆', icon: 'circle', big: true, run: (a) => a.setSketchTool?.('circle'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'circle' },
            { id: 'sk.arc', label: '圆弧', icon: 'arc', big: true, run: (a) => a.setSketchTool?.('arc'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'arc' },
            { id: 'sk.ellipse', label: '椭圆', icon: 'ellipse', big: true, run: (a) => a.setSketchTool?.('ellipse'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'ellipse', tip: '依次点击：中心 → 长轴端点 → 短轴距离' },
            { id: 'sk.slot', label: '槽口', icon: 'slot', big: true, run: (a) => a.setSketchTool?.('slot'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'slot', tip: '依次点击：起点圆心 → 终点圆心 → 槽宽' },
            { id: 'sk.point', label: '点', icon: 'pointIcon', run: (a) => a.setSketchTool?.('point'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'point', tip: '放置参考点，可被异型孔向导当作孔心' },
            { id: 'sk.poly', label: '多边形', icon: 'polygon', run: (a) => a.setSketchTool?.('polygon'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'polygon' },
          ],
        },
        {
          title: '曲线',
          items: [
            { id: 'sk.parabola', label: '抛物线', icon: 'parabola', big: true, run: (a) => a.setSketchTool?.('parabola'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'parabola', tip: '依次点击：顶点 → 焦点 → 开口范围' },
            { id: 'sk.hyperbola', label: '双曲线', icon: 'hyperbola', big: true, run: (a) => a.setSketchTool?.('hyperbola'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'hyperbola', tip: '依次点击：中心 → 实轴端点 → 虚轴距离' },
            { id: 'sk.bspline', label: 'B 样条', icon: 'bspline', big: true, run: (a) => a.setSketchTool?.('bspline'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'bspline', tip: '连续点击放置通过点，按 Enter 结束（回到起点附近自动闭合）' },
          ],
        },
        {
          title: '约束',
          items: [
            { id: 'sk.c.h', label: '水平', icon: 'relation', run: (a) => D.addRelation(a, 'horizontal'), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.c.v', label: '竖直', icon: 'relation', run: (a) => D.addRelation(a, 'vertical'), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.c.co', label: '重合', icon: 'addRelation', run: (a) => D.addRelation(a, 'coincident'), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.c.par', label: '平行', icon: 'relation', run: (a) => D.addRelation(a, 'parallel'), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.c.perp', label: '垂直', icon: 'relation', run: (a) => D.addRelation(a, 'perpendicular'), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.c.eq', label: '相等', icon: 'relation', run: (a) => D.addRelation(a, 'equal'), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.c.tan', label: '相切', icon: 'relation', run: (a) => D.addRelation(a, 'tangent'), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.c.con', label: '同心', icon: 'relation', run: (a) => D.addRelation(a, 'concentric'), enabled: (a) => a.mode === 'sketch' },
          ],
        },
        {
          title: '标注',
          items: [
            { id: 'sk.d.smart', label: '智能尺寸', icon: 'smartDim', big: true, run: (a) => D.smartDimension(a), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.d.cons', label: '构造线', icon: 'construction', run: (a) => D.toggleConstruction(a), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.d.del', label: '删除', icon: 'trim', run: (a) => D.deleteSketchSelection(a), enabled: (a) => a.mode === 'sketch' },
          ],
        },
        {
          title: '编辑',
          items: [
            { id: 'sk.mirror', label: '镜像实体', icon: 'mirrorEntities', big: true, run: (a) => D.mirrorEntities(a), enabled: (a) => a.mode === 'sketch', tip: '以选中的直线为镜像轴，镜像其余选中的实体' },
          ],
        },
        {
          title: '退出',
          items: [
            { id: 'sk.exit', label: '退出草图', icon: 'exitSketch', big: true, run: (a) => a.exitSketch(false), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.cancel', label: '放弃', icon: 'x', run: (a) => a.exitSketch(true), enabled: (a) => a.mode === 'sketch' },
          ],
        },
      ],
    },
    {
      id: 'features',
      label: '特征',
      groups: [
        {
          title: '基于草图',
          items: [
            { id: 'f.extrude', label: '拉伸凸台', icon: 'extrude', big: true, run: (a) => D.extrude(a, 'add'), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length > 0 },
            { id: 'f.cut', label: '拉伸切除', icon: 'extrudeCut', big: true, run: (a) => D.extrude(a, 'cut'), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length > 0 },
            { id: 'f.revolve', label: '旋转', icon: 'revolve', big: true, run: (a) => D.revolve(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length > 0 },
            { id: 'f.loft', label: '放样', icon: 'loft', run: (a) => D.loft(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length >= 2 },
            { id: 'f.sweep', label: '扫描', icon: 'sweep', run: (a) => D.sweep(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length >= 2 },
          ],
        },
        {
          title: '基本体',
          items: [
            { id: 'f.box', label: '长方体', icon: 'box', run: (a) => D.primitive(a, 'box'), enabled: (a) => a.mode !== 'sketch' },
            { id: 'f.cyl', label: '圆柱', icon: 'cylinder', run: (a) => D.primitive(a, 'cylinder'), enabled: (a) => a.mode !== 'sketch' },
            { id: 'f.sph', label: '球', icon: 'sphere', run: (a) => D.primitive(a, 'sphere'), enabled: (a) => a.mode !== 'sketch' },
            { id: 'f.cone', label: '圆锥', icon: 'dome', run: (a) => D.primitive(a, 'cone'), enabled: (a) => a.mode !== 'sketch' },
            { id: 'f.torus', label: '圆环', icon: 'torus', run: (a) => D.primitive(a, 'torus'), enabled: (a) => a.mode !== 'sketch' },
          ],
        },
        {
          title: '工程特征',
          items: [
            { id: 'f.hole', label: '异型孔向导', icon: 'hole', big: true, run: (a) => D.holeWizard(a), enabled: (a) => a.mode === 'model' && a.selection.faces.length === 1 },
            { id: 'f.draft', label: '拔模', icon: 'draft', big: true, run: (a) => D.draft(a), enabled: (a) => a.mode === 'model' && a.selection.faces.length > 0 },
            { id: 'f.rib', label: '筋', icon: 'rib', big: true, run: (a) => D.rib(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length > 0 },
            { id: 'f.fillet', label: '圆角', icon: 'fillet', big: true, run: (a) => D.fillet(a), enabled: (a) => a.mode === 'model' && a.selection.edges.length > 0 },
            { id: 'f.chamfer', label: '倒角', icon: 'chamfer', big: true, run: (a) => D.chamfer(a), enabled: (a) => a.mode === 'model' && a.selection.edges.length > 0 },
            { id: 'f.shell', label: '抽壳', icon: 'shell', big: true, run: (a) => D.shell(a), enabled: (a) => a.mode === 'model' && a.selection.faces.length > 0 },
          ],
        },
        {
          title: '实体编辑',
          items: [
            { id: 'f.movebody', label: '移动/复制', icon: 'moveBody', big: true, run: (a) => D.moveBody(a), enabled: (a) => a.mode !== 'sketch' && a.hasModel, tip: '先绕轴旋转再平移，可选复制多份' },
            { id: 'f.scale', label: '缩放', icon: 'scale', big: true, run: (a) => D.scale(a), enabled: (a) => a.mode !== 'sketch' && a.hasModel, tip: '以指定点为不动点缩放，支持非均匀' },
            { id: 'f.split', label: '分割', icon: 'split', big: true, run: (a) => D.split(a), enabled: (a) => a.mode !== 'sketch' && a.hasModel, tip: '用一个基准面把实体切成多块' },
            { id: 'f.combine', label: '组合', icon: 'combine', big: true, run: (a) => D.combine(a), enabled: (a) => a.mode !== 'sketch' && a.modelSummary().solids >= 2, tip: '把多个实体按并集/差集/交集合成一个' },
            { id: 'f.delbody', label: '删除实体', icon: 'deleteBody', big: true, run: (a) => D.deleteBody(a), enabled: (a) => a.mode !== 'sketch' && a.modelSummary().solids >= 1, tip: '从多实体中移除指定实体' },
          ],
        },
        {
          title: '参考几何体',
          items: [
            { id: 'f.refplane', label: '基准面', icon: 'plane', big: true, run: (a) => D.referencePlane(a), enabled: (a) => a.mode !== 'sketch' },
          ],
        },
        {
          title: '阵列',
          items: [
            { id: 'f.lin', label: '线性阵列', icon: 'linearPattern', big: true, run: (a) => D.linearPattern(a), enabled: (a) => a.mode === 'model' && a.doc.features.length > 0 },
            { id: 'f.cir', label: '圆周阵列', icon: 'circularPattern', big: true, run: (a) => D.circularPattern(a), enabled: (a) => a.mode === 'model' && a.doc.features.length > 0 },
            { id: 'f.mir', label: '镜像', icon: 'mirror', big: true, run: (a) => D.mirror(a), enabled: (a) => a.mode === 'model' && a.doc.features.length > 0 },
          ],
        },
        {
          title: '参数化',
          items: [
            { id: 'f.params', label: '参数表', icon: 'smartDim', big: true, run: (a) => D.parameterTable(a), tip: '全局命名参数 + 公式，一处改动驱动整棵特征树（参考 FreeCAD Expressions）' },
            { id: 'f.expr', label: '表达式', icon: 'relation', big: true, run: (a) => D.featureExpression(a), enabled: (a) => a.doc.features.length > 0, tip: '把当前特征的某个数值参数交给公式驱动' },
          ],
        },
      ],
    },
    {
      id: 'curves',
      label: '曲线',
      groups: [
        {
          title: '曲线',
          items: [
            { id: 'c.spring', label: '弹簧', icon: 'spring', big: true, run: (a) => D.spring(a), enabled: (a) => a.mode !== 'sketch', tip: '圆截面沿螺旋线放样成实体' },
            { id: 'c.spiral', label: '涡状线', icon: 'spiral', big: true, run: (a) => D.spiral(a), enabled: (a) => a.mode !== 'sketch', tip: '阿基米德螺线带材（涡卷弹簧 / 发条）' },
          ],
        },
        {
          title: '沿路径 / 截面',
          items: [
            { id: 'c.sweep', label: '扫描', icon: 'sweep', big: true, run: (a) => D.sweep(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length >= 2, tip: '轮廓沿路径扫掠（路径支持开放折线 / 圆弧 / 闭环）' },
            { id: 'c.loft', label: '放样', icon: 'loft', big: true, run: (a) => D.loft(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length >= 2, tip: '多个截面之间过渡成体' },
          ],
        },
      ],
    },
    {
      id: 'assembly',
      label: '装配体',
      groups: [
        {
          title: '组件',
          items: [
            { id: 'a.insert', label: '插入当前零件', icon: 'insertComponent', big: true, run: (a) => D.insertComponent(a), enabled: (a) => a.mode !== 'sketch' },
            { id: 'a.newpart', label: '新建零件', icon: 'newPart', run: (a) => D.newComponent(a), enabled: (a) => a.mode !== 'sketch' },
            { id: 'a.del', label: '删除组件', icon: 'x', run: (a) => D.deleteComponent(a) },
          ],
        },
        {
          title: '配合',
          items: [
            { id: 'a.mate', label: '配合', icon: 'mate', big: true, run: (a) => D.mate(a), enabled: (a) => a.mode === 'assembly' },
            { id: 'a.solve', label: '重新求解', icon: 'rebuild', run: (a) => D.solveAssembly(a) },
            { id: 'a.fix', label: '固定/浮动', icon: 'fixComponent', run: (a) => D.toggleFixed(a) },
          ],
        },
        {
          title: '检查',
          items: [
            { id: 'a.interf', label: '干涉检查', icon: 'interference', run: (a) => D.interference(a), enabled: (a) => a.mode === 'assembly' },
            { id: 'a.explode', label: '爆炸视图', icon: 'explode', run: (a) => D.explodeDialog(a), enabled: (a) => a.mode === 'assembly' },
          ],
        },
      ],
    },
    {
      id: 'drawing',
      label: '工程图',
      groups: [
        {
          title: '视图',
          items: [
            { id: 'd.gen', label: '生成三视图', icon: 'projectedView', big: true, run: (a) => D.generateDrawing(a, ['front', 'top', 'right', 'iso']), enabled: (a) => a.hasModel },
            { id: 'd.front', label: '主视图', icon: 'front', run: (a) => D.addDrawingView(a, 'front') },
            { id: 'd.top', label: '俯视图', icon: 'top', run: (a) => D.addDrawingView(a, 'top') },
            { id: 'd.right', label: '右视图', icon: 'right', run: (a) => D.addDrawingView(a, 'right') },
            { id: 'd.iso', label: '等轴测', icon: 'isometric', run: (a) => D.addDrawingView(a, 'iso') },
          ],
        },
        {
          title: '标注',
          items: [
            { id: 'd.dim', label: '尺寸标注', icon: 'dimension', big: true, run: (a) => D.drawingDimension(a) },
            { id: 'd.auto', label: '自动标注', icon: 'dimension', big: true, run: (a) => D.autoDimensionDrawing(a) },
            { id: 'd.hole', label: '孔位标注', icon: 'dimension', run: (a) => D.autoHoleDimension(a) },
            { id: 'd.tol', label: '尺寸公差', icon: 'dimension', run: (a) => D.dimensionTolerance(a) },
            { id: 'd.gdt', label: '形位公差', icon: 'dimension', run: (a) => D.gdt(a) },
            { id: 'd.dimclear', label: '清除标注', icon: 'eraseDim', run: (a) => D.clearDrawingDims(a) },
            { id: 'd.hidden', label: '隐藏线开关', icon: 'hiddenLines', run: (a) => D.toggleHiddenLines(a) },
            { id: 'd.bom', label: '明细表', icon: 'bom', run: (a) => D.toggleBOM(a) },
          ],
        },
        {
          title: '输出',
          items: [
            { id: 'd.svg', label: '导出 SVG', icon: 'export', big: true, run: (a) => D.exportDrawingSVG(a) },
            { id: 'd.png', label: '导出 PNG', icon: 'saveAs', run: (a) => D.exportDrawingPNG(a) },
            { id: 'd.title', label: '图纸属性', icon: 'sheetFormat', run: (a) => D.sheetSettings(a) },
          ],
        },
      ],
    },
    {
      id: 'evaluate',
      label: '评估',
      groups: [
        {
          title: '测量',
          items: [
            { id: 'e.mass', label: '质量属性', icon: 'massProps', big: true, run: (a) => a.showMassProperties() },
            { id: 'e.dist', label: '测量距离', icon: 'measure', big: true, run: (a) => a.measureDistance() },
            { id: 'e.info', label: '模型统计', icon: 'info', run: (a) => D.modelInfo(a) },
          ],
        },
        {
          title: '检查',
          items: [
            { id: 'e.geo', label: '几何检查', icon: 'check', run: (a) => D.geometryCheck(a) },
          ],
        },
      ],
    },
    {
      id: 'view',
      label: '视图',
      groups: [
        {
          title: '显示样式',
          items: [
            { id: 'v.se', label: '带边线', icon: 'shaded', big: true, run: (a) => a.setDisplayStyle('shadedEdges'), active: (a) => a.displayStyle === 'shadedEdges' },
            { id: 'v.s', label: '着色', icon: 'realview', run: (a) => a.setDisplayStyle('shaded'), active: (a) => a.displayStyle === 'shaded' },
            { id: 'v.w', label: '线架图', icon: 'wireframe', run: (a) => a.setDisplayStyle('wireframe'), active: (a) => a.displayStyle === 'wireframe' },
            { id: 'v.h', label: '隐藏线', icon: 'hiddenLines', run: (a) => a.setDisplayStyle('hidden'), active: (a) => a.displayStyle === 'hidden' },
            { id: 'v.t', label: '透明', icon: 'transparency', run: (a) => a.setDisplayStyle('transparent'), active: (a) => a.displayStyle === 'transparent' },
          ],
        },
        {
          title: '方向',
          items: [
            { id: 'v.front', label: '主视', icon: 'front', run: (a) => a.setView('front') },
            { id: 'v.top', label: '俯视', icon: 'top', run: (a) => a.setView('top') },
            { id: 'v.right', label: '右视', icon: 'right', run: (a) => a.setView('right') },
            { id: 'v.iso', label: '等轴测', icon: 'isometric', big: true, run: (a) => a.setView('iso') },
            { id: 'v.fit', label: '整屏显示', icon: 'zoomFit', big: true, run: (a) => a.zoomFit() },
          ],
        },
        {
          title: '辅助',
          items: [
            { id: 'v.planes', label: '基准面', icon: 'plane', run: (a) => a.togglePlanes(!a.showPlanes), active: (a) => a.showPlanes },
            { id: 'v.grid', label: '网格', icon: 'grid', run: (a) => a.toggleGrid(!a.showGrid), active: (a) => a.showGrid },
            { id: 'v.origin', label: '原点', icon: 'origin', run: (a) => a.toggleOrigin?.(!a.showOrigin), active: (a) => a.showOrigin },
          ],
        },
      ],
    },
    {
      id: 'file',
      label: '文件',
      groups: [
        {
          title: '项目',
          items: [
            { id: 'p.new', label: '新建', icon: 'new', big: true, run: (a) => D.newProject(a) },
            { id: 'p.open', label: '打开', icon: 'open', big: true, run: (a) => a.openProject() },
            { id: 'p.save', label: '保存', icon: 'save', big: true, run: (a) => a.saveProject() },
          ],
        },
        {
          title: '导出',
          items: [
            { id: 'p.step', label: 'STEP', icon: 'export', big: true, run: (a) => a.exportStep(), enabled: (a) => a.hasModel },
            { id: 'p.stl', label: 'STL', icon: 'save', run: (a) => a.exportStl(), enabled: (a) => a.hasModel },
            { id: 'p.obj', label: 'OBJ', icon: 'saveAs', run: (a) => a.exportObj(), enabled: (a) => a.hasModel },
            { id: 'p.import', label: '导入 STEP', icon: 'importIcon', run: (a) => a.importStepFile() },
          ],
        },
        {
          title: '编辑',
          items: [
            { id: 'p.undo', label: '撤销', icon: 'undo', big: true, run: (a) => a.undo(), enabled: (a) => a.canUndo },
            { id: 'p.redo', label: '重做', icon: 'redo', big: true, run: (a) => a.redo(), enabled: (a) => a.canRedo },
            { id: 'p.rebuild', label: '重建', icon: 'rebuild', run: (a) => a.rebuild() },
          ],
        },
      ],
    },
  ];
}

export function renderRibbon(app: App, tabsHost: HTMLElement, panelHost: HTMLElement): { setTab: (id: string) => void } {
  const tabs = buildTabs();
  let activeTab = 'sketch';

  const setTab = (id: string) => {
    activeTab = id;
    clear(tabsHost);
    for (const t of tabs) {
      tabsHost.appendChild(
        el('button', {
          class: `rtab ${t.id === activeTab ? 'active' : ''}`,
          type: 'button',
          text: t.label,
          onClick: () => setTab(t.id),
        })
      );
    }
    renderPanel();
  };

  const renderPanel = () => {
    const tab = tabs.find((t) => t.id === activeTab) ?? tabs[0];
    clear(panelHost);
    for (const g of tab.groups) {
      const body = el('div', { class: 'rgroup-body' });
      for (const item of g.items) {
        if (item === 'sep') {
          body.appendChild(el('div', { class: 'rsep' }));
          continue;
        }
        const enabled = item.enabled ? item.enabled(app) : true;
        const active = item.active ? item.active(app) : false;
        const btn = el(
          'button',
          {
            class: `rbtn ${item.big ? 'big' : ''} ${active ? 'active' : ''} ${enabled ? '' : 'disabled'}`.trim(),
            type: 'button',
            title: item.tip ?? item.label,
            onClick: async () => {
              if (!enabled) return;
              try {
                // 内核未就绪时先等懒加载完成，避免 oc() 未初始化
                if (!app.kernelReady) {
                  notify.info('几何内核加载中，请稍候…');
                  await app.requireKernel();
                }
                item.run(app);
              } catch (e) {
                notify.err(`${item.label} 失败：${(e as Error).message}`);
              }
            },
          },
          el('span', { class: 'ic', html: icon(item.icon, item.big ? 26 : 16) }),
          el('span', { text: item.label })
        );
        body.appendChild(btn);
      }
      panelHost.appendChild(el('div', { class: 'rgroup' }, body, el('div', { class: 'rgroup-title', text: g.title })));
    }
  };

  setTab(activeTab);
  // 状态变化时重绘按钮的启用/激活态
  app.on('change', renderPanel);
  app.on('selection', renderPanel);
  app.on('mode', renderPanel);
  app.on('tree', renderPanel);

  return { setTab };
}
