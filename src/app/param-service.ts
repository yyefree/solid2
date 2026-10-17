/**
 * 表达式 / 参数服务（App 领域拆分之二，与 selection-store / undo-manager 同构）。
 *
 * 从 `App` 抽出的参数化领域：全局参数表、特征表达式绑定、表达式求值缓存。
 * 服务不持有文档引用（随切文档 / 撤销而变，每次经宿主现取），不依赖
 * DOM / THREE / 内核 → 可在 Node 下单测（见 tools/param-service-test.ts）。
 *
 * 求值缓存的语义（与原 App 行为逐条一致）：
 *   - `resolvedFeatures()` 求值并刷新缓存（`paramValues` / `expressionIssues` /
 *     `lastResolve.featureIssues`），返回数值已替换的特征副本——发给内核的必须用它；
 *   - `paramRows()` 缓存命中则复用，否则现求值并刷新缓存；
 *   - `reset()` 清缓存（强制重建 Ctrl+Q 用）。
 */

import type { CadDocument } from '../doc/model';
import type { ExprIssue, ParamDef, ResolveResult } from '../doc/expr';
import type { Feature, FeatureId } from '../doc/types';
import {
  resolveExpressions,
  previewExpression,
  listNumericParams,
  getParamPath,
} from '../doc/expr';
import type { MutateOpts } from './undo-manager';

/** 参数服务需要的宿主能力（由 App 提供） */
export interface ParamHost {
  /** 当前文档（每次现取——切文档 / 撤销后引用会变） */
  getDoc(): CadDocument;
  /** 统一写入口（压栈 → 执行 → 重建 → 广播） */
  mutate(fn: () => void, opts?: MutateOpts): void;
}

/** 参数表行（供参数表 UI） */
export interface ParamRow {
  name: string;
  expr: string;
  comment?: string;
  value?: number;
  error?: string;
}

/** 特征表达式行（含计算值与错误） */
export interface FeatureExprRow {
  path: string;
  label: string;
  expr: string;
  value?: number;
  error?: string;
}

/** 从解析后的特征里取某个参数路径的具体值 */
function getPathFromResolved(features: Feature[], id: FeatureId, path: string): number | undefined {
  const f = features.find((x) => x.id === id);
  return f ? getParamPath(f.params, path) : undefined;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export class ParamService {
  /** 最近一次表达式解析结果（含参数值、问题列表） */
  private lastResolve: ResolveResult | null = null;
  /** 参数名 → 数值 */
  private paramValues: Record<string, number> = {};
  /** 表达式问题列表 */
  private expressionIssues: ExprIssue[] = [];

  constructor(private readonly host: ParamHost) {}

  // ---- 求值缓存（App.rebuild / forceRebuild / UI 诊断读取）----

  /** 参数名 → 数值（最近一次解析） */
  get values(): Record<string, number> {
    return this.paramValues;
  }

  /** 表达式问题列表（状态栏计数 / 测试读） */
  get issues(): ExprIssue[] {
    return this.expressionIssues;
  }

  /** 按特征聚合的问题（重建时回写特征 error，特征树标红） */
  get featureIssues(): { id: string; message: string }[] {
    return this.lastResolve?.featureIssues ?? [];
  }

  /** 清缓存（强制重建：丢弃表达式缓存重新求值） */
  reset(): void {
    this.lastResolve = null;
    this.paramValues = {};
    this.expressionIssues = [];
  }

  // ---- 求值 ----

  /**
   * 求值全部表达式，返回**已把数值替换为具体值**的特征副本。
   * 所有发给内核的操作都必须用它——内核只认具体数值，不认表达式。
   */
  resolvedFeatures(): Feature[] {
    const r = resolveExpressions(this.host.getDoc());
    this.lastResolve = r;
    this.paramValues = r.paramValues;
    this.expressionIssues = r.issues;
    return r.features;
  }

  /** 全局参数行（供参数表 UI） */
  paramRows(): ParamRow[] {
    const doc = this.host.getDoc();
    const r = this.lastResolve ?? resolveExpressions(doc);
    this.lastResolve = r;
    this.paramValues = r.paramValues;
    this.expressionIssues = r.issues;
    return doc.params.map((p: ParamDef) => {
      const issue = r.issues.find((i) => i.where === `参数:${p.name}`);
      return {
        name: p.name,
        expr: p.expr,
        comment: p.comment,
        value: r.paramValues[p.name],
        error: issue?.message,
      };
    });
  }

  // ---- 全局参数写操作（走宿主 mutate：压栈 + 重建 + 广播）----

  setParam(name: string, expr: string, comment?: string): void {
    this.host.mutate(() => this.host.getDoc().setParam(name.trim(), expr, comment), { emit: ['params'] });
  }

  removeParam(name: string): void {
    const doc = this.host.getDoc();
    // 未绑定的参数：删除是空操作，不值得压栈 + 全模型重建
    if (!doc.params.some((p) => p.name === name)) return;
    this.host.mutate(() => doc.removeParam(name), { emit: ['params'] });
  }

  // ---- 特征表达式 ----

  /** 列出某个特征的数值参数（供表达式对话框选择） */
  featureNumericParams(id: FeatureId): { path: string; label: string; value: number }[] {
    const f = this.host.getDoc().getFeature(id);
    return f ? listNumericParams(f.params) : [];
  }

  /** 某个特征已绑定的表达式（含计算值与错误） */
  featureExpressionRows(id: FeatureId): FeatureExprRow[] {
    const doc = this.host.getDoc();
    const f = doc.getFeature(id);
    if (!f?.expressions) return [];
    const params = listNumericParams(f.params);
    const r = resolveExpressions(doc);
    return Object.keys(f.expressions).map((path) => {
      const issue = r.issues.find((i) => i.where.startsWith(`特征:${f.name}.${path}`));
      return {
        path,
        label: params.find((p) => p.path === path)?.label ?? path,
        expr: f.expressions![path],
        value: issue ? undefined : getPathFromResolved(r.features, f.id, path),
        error: issue?.message,
      };
    });
  }

  /** 给某个特征的某个参数绑定表达式（空文本 = 解除绑定） */
  setFeatureExpression(id: FeatureId, path: string, expr: string): void {
    const f = this.host.getDoc().getFeature(id);
    if (!f) return;
    const text = expr.trim();
    if (!text) {
      this.removeFeatureExpression(id, path);
      return;
    }
    this.host.mutate(() => {
      f.expressions = { ...(f.expressions ?? {}), [path]: text };
    }, { emit: ['params', 'props'] });
  }

  removeFeatureExpression(id: FeatureId, path: string): void {
    const f = this.host.getDoc().getFeature(id);
    if (!f?.expressions || !(path in f.expressions)) return;
    const exprs = f.expressions;
    this.host.mutate(() => {
      delete exprs[path];
      if (!Object.keys(exprs).length) delete f.expressions;
    }, { emit: ['params', 'props'] });
  }

  // ---- 预览 / 候选（纯查询，不改文档）----

  /** 预览一条表达式（不改动文档） */
  previewExpr(src: string): { ok: boolean; value?: number; message?: string } {
    const r = previewExpression(src, this.host.getDoc());
    return r.ok ? { ok: true, value: r.value } : { ok: false, message: r.message };
  }

  /** 供对话框拼引用用的「特征名.属性」候选 */
  referenceCandidates(): { ref: string; label: string }[] {
    const out: { ref: string; label: string }[] = [];
    for (const f of this.host.getDoc().features) {
      for (const p of listNumericParams(f.params)) {
        out.push({ ref: `${f.name}.${p.path}`, label: `${f.name} · ${p.label} = ${round2(p.value)}` });
      }
    }
    return out;
  }
}
