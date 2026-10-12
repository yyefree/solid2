/**
 * AI 建模助手面板。
 *
 * 交互：输入一句中文描述 → 实时解析 → 预览「我理解成了什么」→ 一键生成模型。
 * 解析与编译都在主线程完成（纯计算，不碰几何内核），只有「生成模型」那一步
 * 才把特征交给内核 Worker 重建。
 */
import { el, clear } from './dom';
import { modal, notify } from './toast';
import { icon } from './icons';
import type { App } from '../app/app';
import { defaultProvider, interpret, providers, describeOp } from '../ai';
import type { AiResult } from '../ai';

/** 示例描述（点击即填入） */
const EXAMPLES = [
  '60x40x10 的长方体，中心开半径 8 的通孔，四角倒圆角 R5',
  '半径 20 高 50 的圆柱，上面加一个半径 8 高 12 的圆柱',
  '长 80 宽 60 高 20 的板，四角倒角 4，顶面抽壳 3',
  '边长 40 的立方体，中心开 Φ12 通孔，圆周阵列 4 个',
  '半径 15 高 30 的圆柱，中心开直径 6 的通孔，线性阵列 3 个间距 30',
];

export function openAiModeling(app: App): void {
  const provider = defaultProvider();
  let last: AiResult | null = null;

  // ---------- 输入区 ----------
  const input = el('textarea', {
    class: 'ai-input',
    rows: 3,
    placeholder: '用中文描述你要的零件，例如：60x40x10 的长方体，中心开半径 8 的通孔',
  }) as HTMLTextAreaElement;

  const examples = el(
    'div',
    { class: 'ai-examples' },
    el('span', { class: 'ai-ex-label', text: '试试：' }),
    ...EXAMPLES.map((ex) =>
      el('button', {
        class: 'ai-chip',
        type: 'button',
        text: ex.length > 22 ? `${ex.slice(0, 22)}…` : ex,
        title: ex,
        onClick: () => {
          input.value = ex;
          run();
          input.focus();
        },
      })
    )
  );

  // ---------- 预览区 ----------
  const preview = el('div', { class: 'ai-preview' });

  const body = el(
    'div',
    { class: 'ai-body' },
    el(
      'div',
      { class: 'ai-head' },
      el('span', { class: 'ic', html: icon('ai', 18) }),
      el('div', { class: 'ai-head-txt' },
        el('div', { class: 'ai-title', text: 'AI 建模助手' }),
        el('div', { class: 'ai-sub', text: `${provider.label} · 离线可用，无需联网` })
      )
    ),
    input,
    examples,
    preview
  );

  /** 解析并刷新预览 */
  const run = () => {
    const text = input.value.trim();
    if (!text) {
      last = null;
      renderEmpty();
      return;
    }
    // 本地解析器是同步的，但接口是 Promise —— 统一走 await
    void interpret(text, provider).then((r) => {
      last = r;
      renderResult(r);
    });
  };

  const renderEmpty = () => {
    clear(preview);
    preview.appendChild(el('div', { class: 'ai-hint', text: '输入描述后这里会显示解析结果。' }));
  };

  const renderResult = (r: AiResult) => {
    clear(preview);
    const issues = [...r.plan.issues, ...r.compiled.issues];
    const errs = issues.filter((i) => i.level === 'error');
    const warns = issues.filter((i) => i.level === 'warn');

    if (!r.plan.ops.length) {
      preview.appendChild(el('div', { class: 'ai-err', text: '没有识别出任何建模动作，换个说法试试？' }));
      for (const w of issues) preview.appendChild(issueRow(w.message, w.level));
      return;
    }

    // 理解结果
    preview.appendChild(
      el('div', { class: 'ai-ok' },
        el('span', { class: 'ai-badge', text: `识别 ${r.compiled.features.length} 个特征` }),
        el('span', { text: r.plan.summary })
      )
    );

    // 特征步骤
    const steps = el('ol', { class: 'ai-steps' });
    r.plan.ops.forEach((op, i) => {
      steps.appendChild(
        el('li', {},
          el('span', { class: 'ai-step-name', text: r.compiled.names[i] ?? op.kind }),
          el('span', { class: 'ai-step-desc', text: describeOp(op) })
        )
      );
    });
    preview.appendChild(steps);

    // 尺寸
    if (r.compiled.bbox) {
      const s = [
        r.compiled.bbox.max[0] - r.compiled.bbox.min[0],
        r.compiled.bbox.max[1] - r.compiled.bbox.min[1],
        r.compiled.bbox.max[2] - r.compiled.bbox.min[2],
      ];
      preview.appendChild(
        el('div', { class: 'ai-bbox', text: `包围盒 ${s.map((v) => v.toFixed(1)).join(' × ')} mm` })
      );
    }

    for (const e of errs) preview.appendChild(issueRow(e.message, 'error'));
    for (const w of warns) preview.appendChild(issueRow(w.message, 'warn'));
  };

  const issueRow = (msg: string, level: 'error' | 'warn') =>
    el('div', { class: `ai-issue ${level}`, text: `${level === 'error' ? '✕' : '!'} ${msg}` });

  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + Enter 直接生成
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      apply();
    }
  });

  /** 把解析结果落到文档 */
  const apply = (): boolean => {
    if (!last || !last.compiled.features.length) {
      notify.info('还没有可生成的特征');
      return false;
    }
    const feats = last.compiled.features;
    app
      .requireKernel()
      .then(() => {
        app.loadFeatures(feats, { replace: true, fit: true });
        notify.ok(`AI 已生成 ${feats.length} 个特征`);
      })
      .catch((e) => notify.err(`生成失败：${(e as Error).message}`));
    return true;
  };

  const close = modal({
    title: 'AI 建模助手',
    body,
    width: 620,
    actions: [
      { label: '关闭' },
      { label: '生成模型', primary: true, onClick: apply },
    ],
  });
  void close;

  renderEmpty();
  setTimeout(() => input.focus(), 30);
}

/** 供 ribbon 判断当前有哪些后端可用（云端接入后会有多项） */
export function aiProviderSummary(): string {
  return providers()
    .map((p) => `${p.label}${p.available() ? '' : '（不可用）'}`)
    .join('、');
}

/** 语法帮助对话框：把本地解析器认得的句式摊开给用户看 */
export function openAiHelp(): void {
  const sec = (title: string, lines: string[]) =>
    el(
      'div',
      { class: 'ai-help-sec' },
      el('div', { class: 'ai-help-title', text: title }),
      el('ul', { class: 'ai-help-list' }, ...lines.map((t) => el('li', { text: t })))
    );

  modal({
    title: 'AI 建模 · 语法帮助',
    width: 600,
    body: el(
      'div',
      { class: 'ai-help' },
      el('div', { class: 'ai-help-lead', text: '直接用中文描述零件即可，多个动作可用「，」分隔。当前为本地规则解析（离线可用）。' }),
      sec('基本体', [
        '长方体 / 立方体 / 板 / 方块',
        '圆柱 / 圆盘 / 轴套　　球　　圆锥　　圆环',
      ]),
      sec('尺寸写法', [
        '角色词：长60 宽40 高10 ／ 厚10 ／ 半径8 ／ 直径16 ／ 边长30',
        '符号：R8（半径）　Φ16 或 φ16（直径）',
        '连乘：60x40x10（长方体三边）',
        '单位：默认 mm，可写 10mm / 2cm / 1in',
      ]),
      sec('特征动作', [
        '孔：通孔（自动贯穿）／ 盲孔深10 ／ 中心开半径8的通孔',
        '圆角：四角倒圆角 R5 ／ 倒圆角 R3（全部棱）',
        '倒角：四角倒角 4 ／ 倒角 2',
        '抽壳：顶面抽壳 3 ／ 抽壳 2',
        '阵列：线性阵列 3 个间距 30 ／ 圆周阵列 4 个',
      ]),
      sec('摆放位置', [
        '中心 / 居中 / 原点（默认，与已有实体同心）',
        '上面 / 顶部　　下面 / 底部',
        '右边 / 左侧　　前面 / 后面',
        '例：半径20高50的圆柱，上面加一个半径8高12的圆柱',
      ]),
      sec('限制', [
        '圆角 / 倒角 / 抽壳 目前只作用于「长方体」（几何引用可解析式算出）',
        '抽壳需要开口面（默认顶面开口）',
      ])
    ),
    actions: [{ label: '知道了', primary: true }],
  });
}
