/**
 * AI 建模助手 —— 对外门面。
 *
 * 上层（UI / App）只需要：
 *   // 从零建模型
 *   const { plan, compiled } = await interpret('60x40x10 的长方体，中心开 Φ16 通孔');
 *   app.loadFeatures(compiled.features);
 *
 *   // 在现有模型上继续改
 *   const run = editModel('再加一个半径 8 高 12 的圆柱，把高改成 20', {
 *     features: app.doc.features,
 *     bbox: app.currentModel()?.bbox ?? null,
 *   });
 *   app.setFeatures(run.features);
 *
 * 换解析后端时只改 `provider` 参数（本地规则 ↔ 云端大模型），编译与 UI 不变。
 */

import { compilePlan, type CompileOptions, type CompileResult, type Box } from './compile';
import { localProvider, parseText, summarize, describeOp, normalizeInput } from './parse';
import {
  applyEdits,
  boxRefOf,
  describeChange,
  describeChangeBare,
  describeEdit,
  editModel,
  estimateBBox,
  looksLikeEdit,
  parseEdit,
  summarizeEdits,
  writeParam,
  type AiEdit,
  type EditChange,
  type EditContext,
  type EditResult,
  type EditRun,
  type EditTarget,
} from './edit';
import type { AiPlan, ModelProvider } from './types';

export interface AiResult {
  /** 解析层产物：建模动作 + 问题列表 + 一句话概括 */
  plan: AiPlan;
  /** 编译层产物：可直接塞进文档的特征数组 */
  compiled: CompileResult;
}

/** 当前可用的解析后端（云端 provider 接入后追加到这里即可） */
export function providers(): ModelProvider[] {
  return [localProvider];
}

/** 默认后端 */
export function defaultProvider(): ModelProvider {
  return providers()[0];
}

/**
 * 端到端：自然语言 → 特征数组。
 * 解析与编译的问题会合并返回（`plan.issues` + `compiled.issues`）。
 */
export async function interpret(
  text: string,
  provider: ModelProvider = defaultProvider(),
  opts: CompileOptions = {}
): Promise<AiResult> {
  const plan = await provider.plan(text);
  const compiled = compilePlan(plan.ops, opts);
  return { plan, compiled };
}

export { compilePlan, localProvider, parseText, summarize, describeOp, normalizeInput };
export type { CompileOptions, CompileResult, Box };
export * from './types';

// ---- 编辑现有模型 ----
export {
  applyEdits,
  boxRefOf,
  describeChange,
  describeChangeBare,
  describeEdit,
  editModel,
  estimateBBox,
  looksLikeEdit,
  parseEdit,
  summarizeEdits,
  writeParam,
};
export type { AiEdit, EditChange, EditContext, EditResult, EditRun, EditTarget };
