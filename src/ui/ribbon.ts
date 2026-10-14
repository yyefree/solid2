/**
 * CommandManager（SolidWorks 风格的命令管理器 / Ribbon）。
 *
 * 结构对齐 SolidWorks：
 *   · 选项卡：特征 / 草图 / 评估 / 装配体 / 工程图 / 曲线 / 视图 / AI
 *   · 命令区按「组」划分，组标题在底部居中，组之间用竖线分隔
 *   · 大按钮：32px 图标 + 下方标签；小按钮：3 个一列纵向排列
 */
import { el, clear } from './dom';
import { icon } from './icons';
import type { App } from '../app/app';
import { notify } from './toast';
import { featureDialogs } from './dialogs';
import { surfaceDialogs } from './surface-dialogs';
import { openMeasure } from './measure';
import { openAiModeling, openAiHelp } from './aipanel';
import { openPopup } from './popup';

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
    // ============================================================
    // 特征
    // ============================================================
    {
      id: 'features',
      label: '特征',
      groups: [
        {
          title: '标准',
          items: [
            { id: 'p.new', label: '新建', icon: 'new', big: true, tip: '新建零件（Ctrl+N）', run: (a) => a.newProject() },
            { id: 'p.open', label: '打开', icon: 'open', big: true, tip: '打开 Solid2 项目（Ctrl+O）', run: (a) => a.openProject() },
            { id: 'p.save', label: '保存', icon: 'save', big: true, tip: '保存项目为 JSON（Ctrl+S）', run: (a) => a.saveProject() },
            { id: 'p.undo', label: '撤销', icon: 'undo', tip: '撤销（Ctrl+Z）', run: (a) => a.undo(), enabled: (a) => a.canUndo },
            { id: 'p.redo', label: '重做', icon: 'redo', tip: '重做（Ctrl+Y）', run: (a) => a.redo(), enabled: (a) => a.canRedo },
            { id: 'p.rebuild', label: '重建', icon: 'rebuild', tip: '重建模型（Ctrl+B）', run: (a) => a.rebuildModel() },
          ],
        },
        {
          title: '基于草图',
          items: [
            { id: 'f.extrude', label: '拉伸凸台', icon: 'extrude', big: true, tip: '由草图拉伸出实体', run: (a) => D.extrude(a, 'add'), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length > 0 },
            { id: 'f.cut', label: '拉伸切除', icon: 'extrudeCut', big: true, tip: '用草图轮廓切除材料', run: (a) => D.extrude(a, 'cut'), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length > 0 },
            { id: 'f.revolve', label: '旋转', icon: 'revolve', big: true, tip: '草图绕轴旋转成体', run: (a) => D.revolve(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length > 0 },
            { id: 'f.loft', label: '放样', icon: 'loft', tip: '多个截面之间过渡成体（需 ≥2 个草图）', run: (a) => D.loft(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length >= 2 },
            { id: 'f.sweep', label: '扫描', icon: 'sweep', tip: '轮廓沿路径扫掠（需 ≥2 个草图）', run: (a) => D.sweep(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length >= 2 },
          ],
        },
        {
          title: '基本体',
          items: [
            { id: 'f.box', label: '长方体', icon: 'box', big: true, tip: '直接生成参数化长方体', run: (a) => D.primitive(a, 'box'), enabled: (a) => a.mode !== 'sketch' },
            { id: 'f.cyl', label: '圆柱', icon: 'cylinder', big: true, tip: '直接生成参数化圆柱', run: (a) => D.primitive(a, 'cylinder'), enabled: (a) => a.mode !== 'sketch' },
            { id: 'f.sph', label: '球', icon: 'sphere', tip: '生成球体', run: (a) => D.primitive(a, 'sphere'), enabled: (a) => a.mode !== 'sketch' },
            { id: 'f.cone', label: '圆锥', icon: 'dome', tip: '生成圆锥 / 圆台', run: (a) => D.primitive(a, 'cone'), enabled: (a) => a.mode !== 'sketch' },
            { id: 'f.torus', label: '圆环', icon: 'torus', tip: '生成圆环（甜甜圈）', run: (a) => D.primitive(a, 'torus'), enabled: (a) => a.mode !== 'sketch' },
          ],
        },
        {
          title: '工程特征',
          items: [
            { id: 'f.hole', label: '异型孔向导', icon: 'hole', big: true, tip: '在选中面上打孔（柱形沉头孔 / 锥形沉头孔 / 直孔）', run: (a) => D.holeWizard(a), enabled: (a) => a.mode === 'model' && a.selection.faces.length === 1 },
            { id: 'f.draft', label: '拔模', icon: 'draft', big: true, tip: '给选中面加拔模角', run: (a) => D.draft(a), enabled: (a) => a.mode === 'model' && a.selection.faces.length > 0 },
            { id: 'f.rib', label: '筋', icon: 'rib', big: true, tip: '由开放草图生成加强筋', run: (a) => D.rib(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length > 0 },
            { id: 'f.fillet', label: '圆角', icon: 'fillet', big: true, tip: '对选中边倒圆角', run: (a) => D.fillet(a), enabled: (a) => a.mode === 'model' && a.selection.edges.length > 0 },
            { id: 'f.chamfer', label: '倒角', icon: 'chamfer', big: true, tip: '对选中边倒角', run: (a) => D.chamfer(a), enabled: (a) => a.mode === 'model' && a.selection.edges.length > 0 },
            { id: 'f.shell', label: '抽壳', icon: 'shell', big: true, tip: '挖空实体，保留指定壁厚', run: (a) => D.shell(a), enabled: (a) => a.mode === 'model' && a.selection.faces.length > 0 },
          ],
        },
        {
          title: '实体编辑',
          items: [
            { id: 'f.movebody', label: '移动/复制', icon: 'moveBody', big: true, tip: '先绕轴旋转再平移，可选复制多份', run: (a) => D.moveBody(a), enabled: (a) => a.mode !== 'sketch' && a.hasModel },
            { id: 'f.scale', label: '缩放', icon: 'scale', big: true, tip: '以指定点为不动点缩放，支持非均匀', run: (a) => D.scale(a), enabled: (a) => a.mode !== 'sketch' && a.hasModel },
            { id: 'f.split', label: '分割', icon: 'split', big: true, tip: '用一个基准面把实体切成多块', run: (a) => D.split(a), enabled: (a) => a.mode !== 'sketch' && a.hasModel },
            { id: 'f.combine', label: '组合', icon: 'combine', big: true, tip: '把多个实体按并集 / 差集 / 交集合成一个', run: (a) => D.combine(a), enabled: (a) => a.mode !== 'sketch' && a.modelSummary().solids >= 2 },
            { id: 'f.delbody', label: '删除实体', icon: 'deleteBody', big: true, tip: '从多实体中移除指定实体', run: (a) => D.deleteBody(a), enabled: (a) => a.mode !== 'sketch' && a.modelSummary().solids >= 1 },
          ],
        },
        {
          title: '参考几何体',
          items: [
            { id: 'f.refplane', label: '基准面', icon: 'plane', big: true, tip: '按基准面 / 面偏移创建参考基准面', run: (a) => D.referencePlane(a), enabled: (a) => a.mode !== 'sketch' },
          ],
        },
        {
          title: '阵列',
          items: [
            { id: 'f.lin', label: '线性阵列', icon: 'linearPattern', big: true, tip: '沿方向按间距复制特征', run: (a) => D.linearPattern(a), enabled: (a) => a.mode === 'model' && a.doc.features.length > 0 },
            { id: 'f.cir', label: '圆周阵列', icon: 'circularPattern', big: true, tip: '绕轴按角度均布复制特征', run: (a) => D.circularPattern(a), enabled: (a) => a.mode === 'model' && a.doc.features.length > 0 },
            { id: 'f.mir', label: '镜像', icon: 'mirror', big: true, tip: '关于基准面镜像特征', run: (a) => D.mirror(a), enabled: (a) => a.mode === 'model' && a.doc.features.length > 0 },
          ],
        },
        {
          title: '参数化',
          items: [
            { id: 'f.params', label: '参数表', icon: 'smartDim', big: true, tip: '全局命名参数 + 公式，一处改动驱动整棵特征树（参考 FreeCAD Expressions）', run: (a) => D.parameterTable(a) },
            { id: 'f.expr', label: '表达式', icon: 'relation', big: true, tip: '把当前特征的某个数值参数交给公式驱动', run: (a) => D.featureExpression(a), enabled: (a) => a.doc.features.length > 0 },
          ],
        },
      ],
    },

    // ============================================================
    // 草图
    // ============================================================
    {
      id: 'sketch',
      label: '草图',
      groups: [
        {
          title: '草图',
          items: [
            { id: 'sk.front', label: '草图绘制', icon: 'sketch', big: true, tip: '在前视基准面上新建草图', run: (a) => a.startSketch('front'), enabled: (a) => a.mode !== 'sketch' },
            { id: 'sk.top', label: '上视基准面', icon: 'originPlane', tip: '在上视基准面上新建草图', run: (a) => a.startSketch('top'), enabled: (a) => a.mode !== 'sketch' },
            { id: 'sk.right', label: '右视基准面', icon: 'plane', tip: '在右视基准面上新建草图', run: (a) => a.startSketch('right'), enabled: (a) => a.mode !== 'sketch' },
            { id: 'sk.face', label: '在面上草图', icon: 'modelView', tip: '在选中的模型面上新建草图', run: (a) => D.sketchOnFace(a), enabled: (a) => a.mode === 'model' && a.selection.faces.length === 1 },
          ],
        },
        {
          title: '实体',
          items: [
            { id: 'sk.line', label: '直线', icon: 'line', big: true, tip: '绘制直线（L）', run: (a) => a.setSketchTool?.('line'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'line' },
            { id: 'sk.rect', label: '矩形', icon: 'rectangle', big: true, tip: '绘制矩形（R）', run: (a) => a.setSketchTool?.('rect'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'rect' },
            { id: 'sk.circle', label: '圆', icon: 'circle', big: true, tip: '绘制圆（C）', run: (a) => a.setSketchTool?.('circle'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'circle' },
            { id: 'sk.arc', label: '圆弧', icon: 'arc', big: true, tip: '绘制圆弧（A）', run: (a) => a.setSketchTool?.('arc'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'arc' },
            { id: 'sk.ellipse', label: '椭圆', icon: 'ellipse', big: true, tip: '依次点击：中心 → 长轴端点 → 短轴距离（E）', run: (a) => a.setSketchTool?.('ellipse'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'ellipse' },
            { id: 'sk.slot', label: '槽口', icon: 'slot', big: true, tip: '依次点击：起点圆心 → 终点圆心 → 槽宽（O）', run: (a) => a.setSketchTool?.('slot'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'slot' },
            { id: 'sk.point', label: '点', icon: 'pointIcon', tip: '放置参考点，可被异型孔向导当作孔心（P）', run: (a) => a.setSketchTool?.('point'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'point' },
            { id: 'sk.poly', label: '多边形', icon: 'polygon', tip: '绘制正多边形（N）', run: (a) => a.setSketchTool?.('polygon'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'polygon' },
          ],
        },
        {
          title: '曲线',
          items: [
            { id: 'sk.parabola', label: '抛物线', icon: 'parabola', big: true, tip: '依次点击：顶点 → 焦点 → 开口范围', run: (a) => a.setSketchTool?.('parabola'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'parabola' },
            { id: 'sk.hyperbola', label: '双曲线', icon: 'hyperbola', big: true, tip: '依次点击：中心 → 实轴端点 → 虚轴距离', run: (a) => a.setSketchTool?.('hyperbola'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'hyperbola' },
            { id: 'sk.bspline', label: 'B 样条', icon: 'bspline', big: true, tip: '连续点击放置通过点，按 Enter 结束（B）', run: (a) => a.setSketchTool?.('bspline'), enabled: (a) => a.mode === 'sketch', active: (a) => a.sketchTool === 'bspline' },
          ],
        },
        {
          title: '约束',
          items: [
            { id: 'sk.c.h', label: '水平', icon: 'relation', tip: '添加水平约束', run: (a) => D.addRelation(a, 'horizontal'), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.c.v', label: '竖直', icon: 'relation', tip: '添加竖直约束', run: (a) => D.addRelation(a, 'vertical'), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.c.co', label: '重合', icon: 'addRelation', tip: '添加重合约束', run: (a) => D.addRelation(a, 'coincident'), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.c.par', label: '平行', icon: 'relation', tip: '添加平行约束', run: (a) => D.addRelation(a, 'parallel'), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.c.perp', label: '垂直', icon: 'relation', tip: '添加垂直约束', run: (a) => D.addRelation(a, 'perpendicular'), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.c.eq', label: '相等', icon: 'relation', tip: '添加相等约束', run: (a) => D.addRelation(a, 'equal'), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.c.tan', label: '相切', icon: 'relation', tip: '添加相切约束', run: (a) => D.addRelation(a, 'tangent'), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.c.con', label: '同心', icon: 'relation', tip: '添加同心约束', run: (a) => D.addRelation(a, 'concentric'), enabled: (a) => a.mode === 'sketch' },
          ],
        },
        {
          title: '标注',
          items: [
            { id: 'sk.d.smart', label: '智能尺寸', icon: 'smartDim', big: true, tip: '标注长度 / 半径 / 角度并驱动几何（D）', run: (a) => D.smartDimension(a), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.d.cons', label: '构造线', icon: 'construction', tip: '在普通几何与构造几何之间切换', run: (a) => D.toggleConstruction(a), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.d.del', label: '删除', icon: 'trim', tip: '删除选中的草图实体（T）', run: (a) => D.deleteSketchSelection(a), enabled: (a) => a.mode === 'sketch' },
          ],
        },
        {
          title: '编辑',
          items: [
            { id: 'sk.mirror', label: '镜像实体', icon: 'mirrorEntities', big: true, tip: '以选中的直线为镜像轴，镜像其余选中的实体', run: (a) => D.mirrorEntities(a), enabled: (a) => a.mode === 'sketch' },
          ],
        },
        {
          title: '退出',
          items: [
            { id: 'sk.exit', label: '退出草图', icon: 'exitSketch', big: true, tip: '退出草图并重建模型（Esc）', run: (a) => a.exitSketch(false), enabled: (a) => a.mode === 'sketch' },
            { id: 'sk.cancel', label: '放弃', icon: 'x', tip: '放弃本次草图编辑', run: (a) => a.exitSketch(true), enabled: (a) => a.mode === 'sketch' },
          ],
        },
      ],
    },

    // ============================================================
    // 曲面
    // ============================================================
    {
      id: 'surfaces',
      label: '曲面',
      groups: [
        {
          title: '曲面',
          items: [
            { id: 'su.extrude', label: '拉伸曲面', icon: 'surface', big: true, tip: '草图轮廓沿法向拉伸成曲面（不封顶）', run: (a) => surfaceDialogs.extrude(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length > 0 },
            { id: 'su.revolve', label: '旋转曲面', icon: 'surface', big: true, tip: '草图轮廓绕轴旋转成曲面', run: (a) => surfaceDialogs.revolve(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length > 0 },
            { id: 'su.planar', label: '平面区域', icon: 'surface', big: true, tip: '把闭合草图轮廓填成平面曲面', run: (a) => surfaceDialogs.planar(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length > 0 },
            { id: 'su.loft', label: '放样曲面', icon: 'loft', big: true, tip: '多个草图截面蒙皮成曲面（不封顶）', run: (a) => surfaceDialogs.loft(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length >= 2 },
            { id: 'su.sweep', label: '扫描曲面', icon: 'sweep', big: true, tip: '轮廓草图沿路径草图扫成曲面', run: (a) => surfaceDialogs.sweep(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length >= 2 },
            { id: 'su.trim', label: '裁剪曲面', icon: 'surface', big: true, tip: '用一个平面裁剪所选曲面体，保留一侧', run: (a) => surfaceDialogs.trim(a), enabled: (a) => a.mode !== 'sketch' && a.doc.surfaceFeatures().length > 0 },
            { id: 'su.sew', label: '缝合曲面', icon: 'surface', big: true, tip: '把多个曲面体接合成一个曲面实体', run: (a) => surfaceDialogs.sew(a), enabled: (a) => a.mode !== 'sketch' && a.doc.surfaceFeatures().length >= 2 },
          ],
        },
      ],
    },

    // ============================================================
    // 评估
    // ============================================================
    {
      id: 'evaluate',
      label: '评估',
      groups: [
        {
          title: '测量',
          items: [
            { id: 'e.mass', label: '质量属性', icon: 'massProps', big: true, tip: '体积 / 表面积 / 质心（内核精确积分，非网格近似）', run: (a) => void a.showMassProperties() },
            { id: 'e.dist', label: '测量', icon: 'measure', big: true, tip: '按图形区所选实体实时测量距离/角度/长度/面积/半径（SW 评估→测量）', run: (a) => openMeasure(a) },
            { id: 'e.sec', label: '截面属性', icon: 'sectionPlane', big: true, tip: '选基准面+偏移，实时算截面面积/质心/惯性矩（SW 评估→截面属性）', run: (a) => a.showSectionProperties() },
            { id: 'e.info', label: '模型统计', icon: 'info', tip: '特征数 / 面边体数 / 包围盒 / 重建耗时', run: (a) => D.modelInfo(a) },
          ],
        },
        {
          title: '检查',
          items: [
            { id: 'e.geo', label: '几何检查', icon: 'check', big: true, tip: '检查模型是否存在无效几何', run: (a) => D.geometryCheck(a) },
          ],
        },
      ],
    },

    // ============================================================
    // 装配体
    // ============================================================
    {
      id: 'assembly',
      label: '装配体',
      groups: [
        {
          title: '组件',
          items: [
            { id: 'a.insert', label: '插入当前零件', icon: 'insertComponent', big: true, tip: '把当前零件作为组件插入装配体', run: (a) => D.insertComponent(a), enabled: (a) => a.mode !== 'sketch' },
            { id: 'a.newpart', label: '新建零件', icon: 'newPart', tip: '新建一个空组件', run: (a) => D.newComponent(a), enabled: (a) => a.mode !== 'sketch' },
            { id: 'a.del', label: '删除组件', icon: 'x', tip: '删除选中的组件', run: (a) => D.deleteComponent(a) },
          ],
        },
        {
          title: '配合',
          items: [
            { id: 'a.mate', label: '配合', icon: 'mate', big: true, tip: '在图形区依次拾取两个参考创建配合', run: (a) => D.mate(a), enabled: (a) => a.mode === 'assembly' },
            { id: 'a.solve', label: '重新求解', icon: 'rebuild', tip: '重新求解全部配合', run: (a) => D.solveAssembly(a) },
            { id: 'a.fix', label: '固定/浮动', icon: 'fixComponent', tip: '切换组件的固定 / 浮动状态', run: (a) => D.toggleFixed(a) },
          ],
        },
        {
          title: '检查',
          items: [
            { id: 'a.interf', label: '干涉检查', icon: 'interference', big: true, tip: '检查组件之间的体积干涉', run: (a) => D.interference(a), enabled: (a) => a.mode === 'assembly' },
            { id: 'a.explode', label: '爆炸视图', icon: 'explode', big: true, tip: '按方向把组件炸开', run: (a) => D.explodeDialog(a), enabled: (a) => a.mode === 'assembly' },
          ],
        },
      ],
    },

    // ============================================================
    // 工程图
    // ============================================================
    {
      id: 'drawing',
      label: '工程图',
      groups: [
        {
          title: '视图',
          items: [
            { id: 'd.gen', label: '生成三视图', icon: 'projectedView', big: true, tip: '一次生成主视 / 俯视 / 右视 / 等轴测', run: (a) => D.generateDrawing(a, ['front', 'top', 'right', 'iso']), enabled: (a) => a.hasModel },
            { id: 'd.front', label: '主视图', icon: 'front', tip: '添加主视图', run: (a) => D.addDrawingView(a, 'front') },
            { id: 'd.top', label: '俯视图', icon: 'top', tip: '添加俯视图', run: (a) => D.addDrawingView(a, 'top') },
            { id: 'd.right', label: '右视图', icon: 'right', tip: '添加右视图', run: (a) => D.addDrawingView(a, 'right') },
            { id: 'd.iso', label: '等轴测', icon: 'isometric', tip: '添加等轴测视图', run: (a) => D.addDrawingView(a, 'iso') },
          ],
        },
        {
          title: '标注',
          items: [
            { id: 'd.dim', label: '尺寸标注', icon: 'dimension', big: true, tip: '点击工程图边线添加长度标注', run: (a) => D.drawingDimension(a) },
            { id: 'd.auto', label: '自动标注', icon: 'dimension', big: true, tip: '自动标注总宽 / 总高与直线边', run: (a) => D.autoDimensionDrawing(a) },
            { id: 'd.hole', label: '孔位标注', icon: 'dimension', tip: '自动标注孔中心定位尺寸与直径', run: (a) => D.autoHoleDimension(a) },
            { id: 'd.tol', label: '尺寸公差', icon: 'dimension', tip: '给标注添加上下偏差', run: (a) => D.dimensionTolerance(a) },
            { id: 'd.gdt', label: '形位公差', icon: 'dimension', tip: '添加形位公差框', run: (a) => D.gdt(a) },
            { id: 'd.dimclear', label: '清除标注', icon: 'eraseDim', tip: '清除全部尺寸标注', run: (a) => D.clearDrawingDims(a) },
            { id: 'd.hidden', label: '隐藏线开关', icon: 'hiddenLines', tip: '切换工程图隐藏线显示', run: (a) => D.toggleHiddenLines(a) },
            { id: 'd.bom', label: '明细表', icon: 'bom', tip: '生成 / 清除明细表（数量随装配自动联动）', run: (a) => D.toggleBOM(a) },
          ],
        },
        {
          title: '输出',
          items: [
            { id: 'd.svg', label: '导出 SVG', icon: 'export', big: true, tip: '导出矢量工程图', run: (a) => D.exportDrawingSVG(a) },
            { id: 'd.png', label: '导出 PNG', icon: 'saveAs', tip: '导出 4× 光栅工程图', run: (a) => void D.exportDrawingPNG(a) },
            { id: 'd.title', label: '图纸属性', icon: 'sheetFormat', tip: '设置图幅 / 比例 / 标题栏', run: (a) => D.sheetSettings(a) },
          ],
        },
      ],
    },

    // ============================================================
    // 曲线
    // ============================================================
    {
      id: 'curves',
      label: '曲线',
      groups: [
        {
          title: '曲线',
          items: [
            { id: 'c.spring', label: '弹簧', icon: 'spring', big: true, tip: '圆截面沿螺旋线放样成实体', run: (a) => D.spring(a), enabled: (a) => a.mode !== 'sketch' },
            { id: 'c.spiral', label: '涡状线', icon: 'spiral', big: true, tip: '阿基米德螺线带材（涡卷弹簧 / 发条）', run: (a) => D.spiral(a), enabled: (a) => a.mode !== 'sketch' },
          ],
        },
        {
          title: '沿路径 / 截面',
          items: [
            { id: 'c.sweep', label: '扫描', icon: 'sweep', big: true, tip: '轮廓沿路径扫掠（路径支持开放折线 / 圆弧 / 闭环）', run: (a) => D.sweep(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length >= 2 },
            { id: 'c.loft', label: '放样', icon: 'loft', big: true, tip: '多个截面之间过渡成体', run: (a) => D.loft(a), enabled: (a) => a.mode !== 'sketch' && a.doc.sketchFeatures().length >= 2 },
          ],
        },
      ],
    },

    // ============================================================
    // 视图
    // ============================================================
    {
      id: 'view',
      label: '视图',
      groups: [
        {
          title: '显示样式',
          items: [
            { id: 'v.se', label: '带边线', icon: 'shaded', big: true, tip: '带边线上色', run: (a) => a.setDisplayStyle('shadedEdges'), active: (a) => a.displayStyle === 'shadedEdges' },
            { id: 'v.s', label: '着色', icon: 'realview', tip: '上色（不显示边线）', run: (a) => a.setDisplayStyle('shaded'), active: (a) => a.displayStyle === 'shaded' },
            { id: 'v.w', label: '线架图', icon: 'wireframe', tip: '线架图', run: (a) => a.setDisplayStyle('wireframe'), active: (a) => a.displayStyle === 'wireframe' },
            { id: 'v.h', label: '隐藏线', icon: 'hiddenLines', tip: '消除隐藏线', run: (a) => a.setDisplayStyle('hidden'), active: (a) => a.displayStyle === 'hidden' },
            { id: 'v.t', label: '透明', icon: 'transparency', tip: '透明显示', run: (a) => a.setDisplayStyle('transparent'), active: (a) => a.displayStyle === 'transparent' },
          ],
        },
        {
          title: '方向',
          items: [
            { id: 'v.front', label: '主视', icon: 'front', tip: '前视（Ctrl+1）', run: (a) => a.setView('front') },
            { id: 'v.top', label: '俯视', icon: 'top', tip: '俯视（Ctrl+5）', run: (a) => a.setView('top') },
            { id: 'v.right', label: '右视', icon: 'right', tip: '右视（Ctrl+4）', run: (a) => a.setView('right') },
            { id: 'v.iso', label: '等轴测', icon: 'isometric', big: true, tip: '等轴测（Ctrl+7）', run: (a) => a.setView('iso') },
            { id: 'v.fit', label: '整屏显示', icon: 'zoomFit', big: true, tip: '缩放到合适大小（F）', run: (a) => a.zoomFit() },
          ],
        },
        {
          title: '辅助',
          items: [
            { id: 'v.planes', label: '基准面', icon: 'plane', tip: '显示 / 隐藏基准面', run: (a) => a.togglePlanes(!a.showPlanes), active: (a) => a.showPlanes },
            { id: 'v.grid', label: '网格', icon: 'grid', tip: '显示 / 隐藏网格', run: (a) => a.toggleGrid(!a.showGrid), active: (a) => a.showGrid },
            { id: 'v.origin', label: '原点', icon: 'origin', tip: '显示 / 隐藏原点', run: (a) => a.toggleOrigin?.(!a.showOrigin), active: (a) => a.showOrigin },
          ],
        },
      ],
    },

    // ============================================================
    // AI
    // ============================================================
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
  ];
}

// ============================================================
// 渲染
// ============================================================
export interface RibbonController {
  setTab(id: string): void;
  /** 当前是否折叠（SolidWorks：双击页签折叠 CommandManager） */
  collapsed(): boolean;
  /** 折叠 / 展开切换 */
  toggleCollapse(): void;
  /** 显示 / 隐藏某个页签（SW 右键页签菜单） */
  setTabVisible(id: string, visible: boolean): void;
  /** 隐藏的页签 id 列表 */
  hiddenTabs(): string[];
  findCommand(query: string): CmdId | null;
  runCommand(id: CmdId): void;
  /** 上一次执行的命令（Enter 重复用） */
  hasLastCommand(): boolean;
  rerunLast(): void;
}

/** Ribbon 布局持久化（隐藏页签 + 折叠态），对齐 SW「记住界面状态」 */
const RIBBON_STORE = 'solid2.ribbon.v1';
interface RibbonPrefs { hidden: string[]; collapsed: boolean }
function loadPrefs(): RibbonPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(RIBBON_STORE) ?? '{}') as Partial<RibbonPrefs>;
    return { hidden: Array.isArray(raw.hidden) ? raw.hidden : [], collapsed: !!raw.collapsed };
  } catch {
    return { hidden: [], collapsed: false };
  }
}
function savePrefs(p: RibbonPrefs): void {
  try {
    localStorage.setItem(RIBBON_STORE, JSON.stringify(p));
  } catch {
    /* 忽略（隐私模式） */
  }
}

let controller: RibbonController | null = null;

/** 供菜单栏「搜索命令」使用 */
export function ribbonController(): RibbonController | null {
  return controller;
}

/** makeButton 执行成功后回调（记录上一命令）——模块级 setter，renderRibbon 里赋值 */
let setLastCmd: (id: string) => void = () => {};

export function renderRibbon(app: App, tabsHost: HTMLElement, panelHost: HTMLElement): RibbonController {
  const tabs = buildTabs();
  const prefs = loadPrefs();
  const hidden = new Set<string>(prefs.hidden.filter((id) => tabs.some((t) => t.id === id)));
  let collapsed = prefs.collapsed;
  let activeTab = 'features';
  /** 上一次执行的命令 id（SolidWorks：Enter 重复上一命令） */
  let lastCmdId: string | null = null;

  const allCommands = new Map<CmdId, { btn: RButton; tabId: string }>();
  for (const t of tabs) {
    for (const g of t.groups) {
      for (const it of g.items) {
        if (it !== 'sep') allCommands.set(it.id, { btn: it, tabId: t.id });
      }
    }
  }

  const visibleTabs = () => tabs.filter((t) => !hidden.has(t.id));

  const applyCollapsed = () => {
    panelHost.style.display = collapsed ? 'none' : '';
    tabsHost.classList.toggle('ribbon-collapsed', collapsed);
  };

  const setTab = (id: string) => {
    activeTab = visibleTabs().some((t) => t.id === id) ? id : (visibleTabs()[0]?.id ?? tabs[0].id);
    clear(tabsHost);
    for (const t of visibleTabs()) {
      const btn = el('button', {
        class: `rtab ${t.id === activeTab ? 'active' : ''}`,
        type: 'button',
        text: t.label,
        dataset: { tab: t.id },
        title: `${t.label}（右键选择要显示的页签，双击折叠 CommandManager）`,
        onClick: () => setTab(t.id),
      });
      btn.addEventListener('dblclick', () => toggleCollapse());
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openTabMenu(btn, t.id);
      });
      tabsHost.appendChild(btn);
    }
    renderPanel();
  };

  const toggleCollapse = () => {
    collapsed = !collapsed;
    applyCollapsed();
    savePrefs({ hidden: [...hidden], collapsed });
  };

  /** SolidWorks 右键页签菜单：勾选显示/隐藏页签 + 折叠 Ribbon */
  const openTabMenu = (anchor: HTMLElement, tabId: string) => {
    const r = anchor.getBoundingClientRect();
    openPopup(
      [
        ...tabs.map((t) => ({
          label: t.label,
          checked: !hidden.has(t.id),
          tip: t.id === tabId ? '当前页签' : '',
          run: () => setTabVisible(t.id, hidden.has(t.id)),
        })),
        { sep: true },
        { label: collapsed ? '展开 CommandManager' : '折叠 CommandManager', icon: 'chevronRight', run: () => toggleCollapse() },
      ],
      r.left,
      r.bottom + 2,
      { minWidth: 150 }
    );
  };

  const setTabVisible = (id: string, visible: boolean) => {
    if (visible) hidden.delete(id);
    else {
      if (hidden.size + 1 >= tabs.length) {
        notify.info('至少保留一个页签');
        return;
      }
      hidden.add(id);
    }
    savePrefs({ hidden: [...hidden], collapsed });
    setTab(activeTab);
  };

  const renderPanel = () => {
    const tab = tabs.find((t) => t.id === activeTab) ?? tabs[0];
    clear(panelHost);
    for (const g of tab.groups) {
      const body = el('div', { class: 'rgroup-body' });

      // 连续的小按钮按 3 个一列打包
      let col: HTMLElement | null = null;
      let inCol = 0;
      const flushCol = () => {
        col = null;
        inCol = 0;
      };

      for (const item of g.items) {
        if (item === 'sep') {
          flushCol();
          body.appendChild(el('div', { class: 'rsep' }));
          continue;
        }
        const btn = makeButton(app, item);
        if (item.big) {
          flushCol();
          body.appendChild(btn);
        } else {
          if (!col || inCol >= 3) {
            col = el('div', { class: 'rcol' });
            body.appendChild(col);
            inCol = 0;
          }
          col.appendChild(btn);
          inCol++;
        }
      }
      panelHost.appendChild(el('div', { class: 'rgroup' }, body, el('div', { class: 'rgroup-title', text: g.title })));
    }
  };

  setTab(activeTab);
  applyCollapsed();
  // 状态变化时重绘按钮的启用 / 激活态
  app.on('change', renderPanel);
  app.on('selection', renderPanel);
  app.on('mode', renderPanel);
  app.on('tree', renderPanel);

  controller = {
    setTab,
    collapsed: () => collapsed,
    toggleCollapse,
    setTabVisible,
    hiddenTabs: () => [...hidden],
    findCommand(query: string): CmdId | null {
      const q = query.trim().toLowerCase();
      if (!q) return null;
      let fuzzy: CmdId | null = null;
      for (const [id, { btn }] of allCommands) {
        const label = btn.label.toLowerCase();
        if (label === q) return id;
        if (!fuzzy && (label.includes(q) || q.includes(label))) fuzzy = id;
      }
      return fuzzy;
    },
    runCommand(id: CmdId): void {
      const hit = allCommands.get(id);
      if (!hit) return;
      // 命令所在页签被隐藏时先显示出来（SW 搜索/菜单执行同样会带出页签）
      if (hidden.has(hit.tabId)) setTabVisible(hit.tabId, true);
      setTab(hit.tabId);
      // 等一帧让按钮挂到 DOM 上再点击（走同一条执行路径，含内核懒加载）
      requestAnimationFrame(() => {
        const node = panelHost.querySelector(`[data-cmd="${id}"]`) as HTMLButtonElement | null;
        if (node) node.click();
      });
    },
    hasLastCommand: () => !!lastCmdId,
    rerunLast: () => {
      if (lastCmdId) controller?.runCommand(lastCmdId);
    },
  };
  // 记录「上一次执行的命令」（Enter 重复）
  setLastCmd = (id: string) => {
    lastCmdId = id;
  };
  return controller;
}

function makeButton(app: App, item: RButton): HTMLElement {
  const enabled = item.enabled ? item.enabled(app) : true;
  const active = item.active ? item.active(app) : false;
  const btn = el(
    'button',
    {
      class: `rbtn ${item.big ? 'big' : ''} ${active ? 'active' : ''} ${enabled ? '' : 'disabled'}`.trim(),
      type: 'button',
      title: item.tip ?? item.label,
      dataset: { cmd: item.id },
      onClick: async () => {
        if (!enabled) return;
        try {
          // 内核未就绪时先等懒加载完成，避免 oc() 未初始化
          if (!app.kernelReady) {
            notify.info('几何内核加载中，请稍候…');
            await app.requireKernel();
          }
          item.run(app);
          setLastCmd(item.id); // Enter「重复上一命令」
        } catch (e) {
          notify.err(`${item.label} 失败：${(e as Error).message}`);
        }
      },
    },
    el('span', { class: 'ic', html: icon(item.icon, item.big ? 30 : 16) }),
    el('span', { class: 'rbtn-label', text: item.label })
  );
  return btn;
}
