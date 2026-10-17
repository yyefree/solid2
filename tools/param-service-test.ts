/**
 * 表达式 / 参数服务单测（纯计算，不依赖 DOM / THREE / 内核 / OCCT）。
 *
 * 覆盖 `src/app/param-service.ts` 的核心不变量：
 *   - resolvedFeatures 求值并刷新缓存（values / issues / featureIssues），原文档不被修改
 *   - paramRows 命中缓存则复用，未命中则现求值并刷新；错误映射到行
 *   - setParam / removeParam / setFeatureExpression / removeFeatureExpression 走宿主 mutate
 *     （emit 事件正确；空文本 = 解除绑定；删空后 expressions 字段移除）
 *   - featureNumericParams / featureExpressionRows / previewExpr / referenceCandidates 纯查询
 *   - reset 清缓存（强制重建语义）
 */
import { CadDocument } from '../src/doc/model';
import { newId } from '../src/sketch/types';
import { ParamService, type ParamHost } from '../src/app/param-service';
import type { Feature } from '../src/doc/types';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}

/** 宿主 mock：真 CadDocument（纯 JS）+ mutate 调用记录 */
function makeHost() {
  const doc = new CadDocument();
  const mutates: { emit?: string[] }[] = [];
  const host: ParamHost = {
    getDoc: () => doc,
    mutate: (fn, opts) => { mutates.push({ emit: opts?.emit }); fn(); },
  };
  return { host, doc, mutates, svc: new ParamService(host) };
}

function extrudeFeature(id = 'f1', distance = 10, name = '拉伸1'): Feature {
  return {
    id,
    type: 'extrude',
    name,
    params: { sketchId: 's0', distance, operation: 'new' as const },
  } as Feature;
}

// ---- resolvedFeatures：求值 + 缓存刷新 ----
{
  const { svc, doc } = makeHost();
  doc.setParam('板厚', '8');
  const f = extrudeFeature();
  (f as unknown as { expressions: Record<string, string> }).expressions = { distance: '板厚*2' };
  doc.add(f);

  const features = svc.resolvedFeatures();
  check('resolvedFeatures：表达式求值写入返回的副本', features[0].params.distance === 16,
    `distance=${features[0].params.distance}`);
  check('resolvedFeatures：原文档不被修改（深拷贝）', f.params.distance === 10);
  check('resolvedFeatures：缓存 values 刷新', svc.values['板厚'] === 8);
  check('resolvedFeatures：无问题时 issues 为空', svc.issues.length === 0 && svc.featureIssues.length === 0);
}

// ---- 表达式错误 → issues / featureIssues ----
{
  const { svc, doc } = makeHost();
  const f = extrudeFeature();
  (f as unknown as { expressions: Record<string, string> }).expressions = { distance: '板厚 + 未知参数' };
  doc.add(f);
  svc.resolvedFeatures();
  check('错误表达式进 issues', svc.issues.length === 1 && svc.issues[0].where.startsWith('特征:拉伸1.distance'));
  check('错误按特征聚合进 featureIssues', svc.featureIssues.length === 1 && svc.featureIssues[0].id === 'f1');
}

// ---- paramRows：缓存复用 + 值/错误映射 ----
{
  const { svc, doc } = makeHost();
  doc.setParam('板厚', '8');
  doc.setParam('坏参数', '1 +');
  const rows = svc.paramRows();
  const thick = rows.find((r) => r.name === '板厚')!;
  check('paramRows：参数值来自求值', thick.value === 8 && thick.expr === '8', JSON.stringify(thick));
  const bad = rows.find((r) => r.name === '坏参数')!;
  check('paramRows：错误映射到行（value 缺省 + error 有文案）',
    bad.value === undefined && !!bad.error, JSON.stringify(bad));

  // 缓存真语义：首次 paramRows 后**绕过服务**直接改文档 → 行来自新文档、
  // 但值仍取旧解析；reset()（强制重建语义）之后才重新求值。
  // （只看 issues 计数无法区分「复用」与「每次重算」，必须钉住值本身。）
  svc.paramRows();
  doc.params[0].expr = '80';
  const staleRow = svc.paramRows().find((r) => r.name === '板厚')!;
  check('paramRows：命中缓存时复用旧求值（文档已变仍返回旧值 8）',
    staleRow.value === 8, `value=${staleRow.value}`);
  svc.reset();
  const freshRow = svc.paramRows().find((r) => r.name === '板厚')!;
  check('paramRows：reset 后重新求值（返回新值 80）', freshRow.value === 80, `value=${freshRow.value}`);
}

// ---- setParam / removeParam：走 mutate + emit ----
{
  const { svc, doc, mutates } = makeHost();
  svc.setParam(' 宽 ', ' 60 ');
  check('setParam：走宿主 mutate（emit=[params]）',
    mutates.length === 1 && mutates[0].emit?.join(',') === 'params', JSON.stringify(mutates));
  // 与原 App 行为一致：仅名称 trim，expr 原样入库（求值器容忍空白）
  check('setParam：名称 trim 后写入文档（expr 原样）',
    doc.params.some((p) => p.name === '宽' && p.expr === ' 60 '), JSON.stringify(doc.params));

  svc.removeParam('宽');
  check('removeParam：走宿主 mutate（emit=[params]）',
    mutates.length === 2 && mutates[1].emit?.join(',') === 'params');
  check('removeParam：文档中已移除', !doc.params.some((p) => p.name === '宽'));
}

// ---- featureNumericParams / referenceCandidates：纯查询 ----
{
  const { svc, doc } = makeHost();
  const f = extrudeFeature();
  doc.add(f);
  const nums = svc.featureNumericParams(f.id);
  check('featureNumericParams：列出数值参数（distance）',
    nums.some((p) => p.path === 'distance' && p.value === 10), JSON.stringify(nums));
  check('featureNumericParams：不存在特征返回空数组', svc.featureNumericParams('nope').length === 0);

  const refs = svc.referenceCandidates();
  check('referenceCandidates：「特征名.属性」候选',
    refs.some((r) => r.ref === '拉伸1.distance' && r.label.includes('= 10')), JSON.stringify(refs));
}

// ---- featureExpressionRows：绑定表达式的值 / 错误 ----
{
  const { svc, doc } = makeHost();
  doc.setParam('板厚', '8');
  const f1 = extrudeFeature('f1');
  (f1 as unknown as { expressions: Record<string, string> }).expressions = { distance: '板厚' };
  doc.add(f1);
  const f2 = extrudeFeature('f2', 10, '拉伸2');
  (f2 as unknown as { expressions: Record<string, string> }).expressions = { distance: '不存在' };
  doc.add(f2);

  const rows = svc.featureExpressionRows(f1.id);
  check('featureExpressionRows：正常绑定带计算值',
    rows.length === 1 && rows[0].path === 'distance' && rows[0].value === 8 && !rows[0].error,
    JSON.stringify(rows));
  const bad = svc.featureExpressionRows(f2.id);
  check('featureExpressionRows：错误绑定 value 缺省 + error 有文案',
    bad.length === 1 && bad[0].value === undefined && !!bad[0].error, JSON.stringify(bad));
  check('featureExpressionRows：无表达式特征返回空', svc.featureExpressionRows('nope').length === 0);
}

// ---- setFeatureExpression / removeFeatureExpression ----
{
  const { svc, doc, mutates } = makeHost();
  const f = extrudeFeature();
  doc.add(f);

  svc.setFeatureExpression(f.id, 'distance', ' =板厚 ');
  check('setFeatureExpression：走宿主 mutate（emit=[params,props]）',
    mutates.length === 1 && mutates[0].emit?.join(',') === 'params,props', JSON.stringify(mutates));
  check('setFeatureExpression：trim 后写入（= 前缀保留）',
    (f as unknown as { expressions: Record<string, string> }).expressions.distance === '=板厚');

  svc.setFeatureExpression(f.id, 'distance', '   ');
  check('setFeatureExpression：空文本 = 解除绑定（走 removeFeatureExpression）',
    (f as unknown as { expressions?: Record<string, string> }).expressions === undefined,
    JSON.stringify((f as unknown as { expressions?: unknown }).expressions));
  check('解除绑定也走宿主 mutate', mutates.length === 2);

  svc.setFeatureExpression(f.id, 'distance', '5');
  svc.setFeatureExpression(f.id, 'distance', '7');
  check('重复绑定同键不叠加（替换）',
    Object.keys((f as unknown as { expressions: Record<string, string> }).expressions).length === 1);
  svc.removeFeatureExpression(f.id, 'distance');
  check('removeFeatureExpression：删空后 expressions 字段整体移除',
    (f as unknown as { expressions?: unknown }).expressions === undefined);
}

// ---- removeParam / removeFeatureExpression：未绑定时不压栈不重建 ----
{
  const { svc, doc, mutates } = makeHost();
  svc.removeParam('不存在的参数');
  check('removeParam：未绑定的参数 → 不压栈、不改文档',
    mutates.length === 0 && doc.params.length === 0, JSON.stringify(mutates));

  const f = extrudeFeature();
  doc.add(f);
  svc.removeFeatureExpression(f.id, 'distance');
  check('removeFeatureExpression：特征无 expressions 字段 → 不压栈', mutates.length === 0);
  svc.setFeatureExpression(f.id, 'distance', '2*3');
  check('setFeatureExpression：绑定成功（压栈 1 次）', mutates.length === 1);
  svc.removeFeatureExpression(f.id, 'weight');
  check('removeFeatureExpression：未绑定的 path → 不压栈', mutates.length === 1);
  svc.removeFeatureExpression(f.id, 'distance');
  check('removeFeatureExpression：已绑定的 path → 压栈并删除（空后整字段移除）',
    mutates.length === 2 && (f as unknown as { expressions?: unknown }).expressions === undefined);
}

// ---- previewExpr：不改文档 ----
{
  const { svc, doc } = makeHost();
  doc.setParam('板厚', '8');
  const ok = svc.previewExpr('板厚 * 3');
  check('previewExpr：可求值返回 ok + value', ok.ok && ok.value === 24, JSON.stringify(ok));
  const bad = svc.previewExpr('板厚 +');
  check('previewExpr：语法错误返回 message', !bad.ok && !!bad.message, JSON.stringify(bad));
  check('previewExpr：不产生参数（不改文档）', doc.params.length === 1);
}

// ---- reset：清缓存 ----
{
  const { svc, doc } = makeHost();
  doc.setParam('板厚', '8');
  svc.resolvedFeatures();
  check('reset 前缓存非空', Object.keys(svc.values).length === 1);
  svc.reset();
  check('reset：values / issues / featureIssues 全清',
    Object.keys(svc.values).length === 0 && svc.issues.length === 0 && svc.featureIssues.length === 0);
}

console.log(`\n参数服务：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
if (fail > 0) process.exit(1);
