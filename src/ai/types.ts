/**
 * AI 建模助手 —— 中间表示（IR）与模型提供方接口。
 *
 * 分层意图：把「自然语言 → 可建模动作」拆成两层，各自独立可测：
 *
 *   文本 ──(1) 解析层 parse.ts──▶ AiOp[] ──(2) 编译层 compile.ts──▶ Feature[]
 *
 * - 第 1 层只产出与几何内核无关的 `AiOp`，是「意图」；
 * - 第 2 层把意图编译成文档层的 `Feature[]`（基本体 / 孔 / 圆角 / 阵列……），是「落地」。
 *
 * 这样换掉解析器（本地规则 → 云端大模型）时，编译层与 UI 一行都不用改：
 * 云端模型只要按 `ModelProvider` 契约吐出一份 `AiPlan`（同样的 AiOp 数组）即可。
 * 这也是本仓库 `ai` 分支的预留接口——云服务开通后新增一个 CloudProvider 即可，
 * 无需触碰 parse/compile/UI。
 */

export type Vec3 = [number, number, number];

/** 布尔操作，取值与 `doc/types` 的 `BooleanOp` 对齐 */
export type AiBoolOp = 'new' | 'add' | 'cut' | 'intersect';

export type PrimitiveKind = 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus';

/** 相对已有实体的摆放位置（默认居中重叠） */
export type Placement = 'center' | 'top' | 'bottom' | 'right' | 'left' | 'front' | 'back';

/** 圆角 / 倒角的作用范围 */
export type EdgeScope = 'all' | 'vertical' | 'top' | 'bottom';

export interface AiOpBase {
  /** 该动作来自哪一段原文（UI 回显 / 调试用） */
  source: string;
}

/** 基本体：长方体 / 圆柱 / 球 / 圆锥 / 圆环 */
export interface AiPrimitiveOp extends AiOpBase {
  kind: PrimitiveKind;
  /** box:[dx,dy,dz] cylinder:[r,h] sphere:[r] cone:[r1,r2,h] torus:[r1,r2]（单位 mm） */
  dims: number[];
  operation: AiBoolOp;
  place: Placement;
}

/** 孔：默认沿 -Z 从实体上表面中心钻入 */
export interface AiHoleOp extends AiOpBase {
  kind: 'hole';
  radius: number;
  through: boolean;
  /** 盲孔深度（通孔时忽略） */
  depth: number;
  place: Placement;
}

export interface AiFilletOp extends AiOpBase {
  kind: 'fillet';
  radius: number;
  scope: EdgeScope;
}

export interface AiChamferOp extends AiOpBase {
  kind: 'chamfer';
  distance: number;
  scope: EdgeScope;
}

/** 抽壳：目前只支持顶面开口（引擎要求至少移除一个面） */
export interface AiShellOp extends AiOpBase {
  kind: 'shell';
  thickness: number;
  open: 'top' | 'bottom';
}

export interface AiLinearPatternOp extends AiOpBase {
  kind: 'linearPattern';
  axis: 'x' | 'y' | 'z';
  spacing: number;
  count: number;
}

export interface AiCircularPatternOp extends AiOpBase {
  kind: 'circularPattern';
  axis: 'x' | 'y' | 'z';
  count: number;
  totalAngleDeg: number;
}

export type AiOp =
  | AiPrimitiveOp
  | AiHoleOp
  | AiFilletOp
  | AiChamferOp
  | AiShellOp
  | AiLinearPatternOp
  | AiCircularPatternOp;

/** 解析层问题：某个子句没读懂，或读懂了但缺参数 */
export interface ParseIssue {
  /** 出问题的子句原文 */
  clause: string;
  message: string;
  level: 'error' | 'warn';
}

/** 一次解析的完整结果 */
export interface AiPlan {
  ops: AiOp[];
  issues: ParseIssue[];
  /** 一句话概括「我理解成了什么」，供 UI 回显 */
  summary: string;
  /** 产生该计划的后端标识（local / cloud:xxx） */
  provider: string;
}

/**
 * 模型提供方契约。
 *
 * 本地规则解析器（`localProvider`）与将来的云端大模型 provider 都实现它，
 * 上层（UI / App）只依赖这个接口，不关心背后是谁在解析。
 */
export interface ModelProvider {
  readonly id: string;
  readonly label: string;
  /** 当前是否可用（本地解析器恒为 true；云端 provider 需环境就绪） */
  available(): boolean;
  /** 把自然语言解析成一份建模计划 */
  plan(text: string): Promise<AiPlan>;
}
