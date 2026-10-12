/**
 * AI 建模助手面板。
 *
 * 两种模式：
 *   - **新建模型**：一句话从零建模型（解析 → 编译 → 落地）；
 *   - **编辑当前模型**：在现有特征树上「追加 / 改尺寸 / 删除」。
 *
 * 解析与编译都在主线程完成（纯计算，不碰几何内核），只有点「应用」那一步
 * 才把特征交给内核 Worker 重建。
 */
import { el, clear } from './dom';
import { modal, notify } from './toast';
import { icon } from './icons';
import type { App } from '../app/app';
import {
  boxRefOf,
  defaultProvider,
  describeChangeBare,
  describeEdit,
  describeOp,
  editModel,
  interpret,
  providers,
} from '../ai';
import type { AiResult, EditContext, EditRun } from '../ai';

/** 新建模式示例（点击即填入） */
const CREATE_EXAMPLES = [
  '60x40x10 的长方体，中心开半径 8 的通孔，四角倒圆角 R5',
  '半径 20 高 50 的圆柱，上面加一个半径 8 高 12 的圆柱',
  '长 80 宽 60 高 20 的板，四角倒角 4，顶面抽壳 3',
  '边长 40 的立方体，中心开 Φ12 通孔，圆周阵列 4 个',
];

/** 编辑模式示例 */
const EDIT_EXAMPLES = [
  '上面加一个半径 8 高 12 的圆柱',
  '中心开半径 8 的通孔',
  '把高改成 20',
  '把直径改成 12',
  '删掉圆角',
];

type Mode = 'create' | 'edit';

export function openAiModeling(app: App, opts: { mode?: Mode } = {}): void {
  const provider = defaultProvider();
  let mode: Mode = opts.mode ?? (app.doc.features.length ? 'edit' : 'create');
  let lastCreate: AiResult | null = null;
  let lastEdit: EditRun | null = null;

  // ---------- 模式切换 ----------
  const modeBar = el('div', { class: 'ai-modes' });
  const modeBtns: Record<Mode, HTMLButtonElement> = {
    create: el('button', { class: 'ai-mode', type: 'button', text: '新建模型' }) as HTMLButtonElement,
    edit: el('button', { class: 'ai-mode', type: 'button', text: '编辑当前模型' }) as HTMLButtonElement,
  };
  for (const m of ['create', 'edit'] as Mode[]) {
    modeBtns[m].addEventListener('click', () => {
      mode = m;
      syncMode();
      run();
    });
    modeBar.appendChild(modeBtns[m]);
  }

  const modelHint = el('div', { class: 'ai-model-hint' });

  // ---------- 输入区 ----------
  const input = el('textarea', {
    class: 'ai-input',
    rows: 3,
  }) as HTMLTextAreaElement;

  const exampleBox = el('div', { class: 'ai-examples' });

  // ---------- 预览区 ----------
  const preview = el('div', { class: 'ai-preview' });

  const body = el(
    'div',
    { class: 'ai-body' },
    el(
      'div',
      { class: 'ai-head' },
      el('span', { class: 'ic', html: icon('ai', 18) }),
      el(
        'div',
        { class: 'ai-head-txt' },
        el('div', { class: 'ai-title', text: 'AI 建模助手' }),
        el('div', { class: 'ai-sub', text: `${provider.label} · 离线可用，无需联网` })
      )
    ),
    modeBar,
    modelHint,
    input,
    exampleBox,
    preview
  );

  /** 当前文档的编辑上下文 */
  const editCtx = (): EditContext => ({
    features: app.doc.features,
    bbox: app.currentBBox(),
    boxForRefs: boxRefOf(app.doc.features),
  });

  /** 切换模式时刷新提示语与示例 */
  const syncMode = () => {
    const n = app.doc.features.length;
    modeBtns.create.classList.toggle('on', mode === 'create');
    modeBtns.edit.classList.toggle('on', mode === 'edit');
    modeBtns.edit.disabled = n === 0;
    modeBtns.edit.title = n === 0 ? '当前还没有模型，先建一个再编辑' : `在现有 ${n} 个特征上继续改`;

    input.placeholder =
      mode === 'edit'
        ? '在现有模型上继续改，例如：上面加一个半径 8 高 12 的圆柱，把高改成 20'
        : '用中文描述你要的零件，例如：60x40x10 的长方体，中心开半径 8 的通孔';

    modelHint.textContent =
      mode === 'edit' ? `当前模型：${n} 个特征（${summarizeTypes(app)}）` : '';

    clear(exampleBox);
    exampleBox.appendChild(el('span', { class: 'ai-ex-label', text: '试试：' }));
    for (const ex of mode === 'edit' ? EDIT_EXAMPLES : CREATE_EXAMPLES) {
      exampleBox.appendChild(
        el('button', {
          class: 'ai-chip',
          type: 'button',
          text: ex.length > 24 ? `${ex.slice(0, 24)}…` : ex,
          title: ex,
          onClick: () => {
            input.value = ex;
            run();
            input.focus();
          },
        })
      );
    }
  };

  /** 解析并刷新预览 */
  const run = () => {
    const text = input.value.trim();
    if (!text) {
      lastCreate = null;
      lastEdit = null;
      renderHint('输入描述后这里会显示解析结果。');
      return;
    }
    if (mode === 'edit') {
      if (!app.doc.features.length) {
        renderHint('当前还没有模型，先切到「新建模型」建一个。');
        return;
      }
      lastEdit = editModel(text, editCtx());
      renderEdit(lastEdit);
      return;
    }
    // 本地解析器是同步的，但接口是 Promise —— 统一走 await
    void interpret(text, provider).then((r) => {
      lastCreate = r;
      renderCreate(r);
    });
  };

  const renderHint = (text: string) => {
    clear(preview);
    preview.appendChild(el('div', { class: 'ai-hint', text }));
  };

  const issueRow = (msg: string, level: 'error' | 'warn') =>
    el('div', { class: `ai-issue ${level}`, text: `${level === 'error' ? '✕' : '!'} ${msg}` });

  // ---------- 新建模式预览 ----------
  const renderCreate = (r: AiResult) => {
    clear(preview);
    const issues = [...r.plan.issues, ...r.compiled.issues];
    const errs = issues.filter((i) => i.level === 'error');
    const warns = issues.filter((i) => i.level === 'warn');

    if (!r.plan.ops.length) {
      preview.appendChild(el('div', { class: 'ai-err', text: '没有识别出任何建模动作，换个说法试试？' }));
      for (const w of issues) preview.appendChild(issueRow(w.message, w.level));
      return;
    }

    preview.appendChild(
      el(
        'div',
        { class: 'ai-ok' },
        el('span', { class: 'ai-badge', text: `识别 ${r.compiled.features.length} 个特征` }),
        el('span', { text: r.plan.summary })
      )
    );

    const steps = el('ol', { class: 'ai-steps' });
    r.plan.ops.forEach((op, i) => {
      steps.appendChild(
        el(
          'li',
          {},
          el('span', { class: 'ai-step-name', text: r.compiled.names[i] ?? op.kind }),
          el('span', { class: 'ai-step-desc', text: describeOp(op) })
        )
      );
    });
    preview.appendChild(steps);

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

  // ---------- 编辑模式预览 ----------
  const renderEdit = (run: EditRun) => {
    clear(preview);
    const errs = run.issues.filter((i) => i.level === 'error');
    const warns = run.issues.filter((i) => i.level === 'warn');

    if (!run.edits.length) {
      preview.appendChild(el('div', { class: 'ai-err', text: '没看懂这条编辑指令，换个说法试试？' }));
      for (const i of [...errs, ...warns]) preview.appendChild(issueRow(i.message, i.level));
      return;
    }

    // 我理解成了什么
    const steps = el('ol', { class: 'ai-steps' });
    for (const ed of run.edits) {
      steps.appendChild(el('li', {}, el('span', { class: 'ai-step-desc', text: describeEdit(ed) })));
    }
    preview.appendChild(
      el(
        'div',
        { class: 'ai-ok' },
        el('span', { class: 'ai-badge', text: `${run.changes.length} 处改动` }),
        el('span', { text: `${app.doc.features.length} → ${run.features.length} 个特征` })
      )
    );
    preview.appendChild(steps);

    if (run.changes.length) {
      const list = el('ul', { class: 'ai-changes' });
      for (const c of run.changes) {
        list.appendChild(
          el(
            'li',
            {},
            el('span', { class: `ai-chg-kind ${c.kind}`, text: CHG_LABEL[c.kind] }),
            el('span', { text: describeChangeBare(c) })
          )
        );
      }
      preview.appendChild(list);
    } else {
      preview.appendChild(el('div', { class: 'ai-hint', text: '解析成功，但没有产生实际改动。' }));
    }

    if (run.bbox) {
      const s = [run.bbox.max[0] - run.bbox.min[0], run.bbox.max[1] - run.bbox.min[1], run.bbox.max[2] - run.bbox.min[2]];
      preview.appendChild(el('div', { class: 'ai-bbox', text: `预计包围盒 ${s.map((v) => v.toFixed(1)).join(' × ')} mm` }));
    }

    for (const e of errs) preview.appendChild(issueRow(e.message, 'error'));
    for (const w of warns) preview.appendChild(issueRow(w.message, 'warn'));
  };

  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + Enter 直接应用
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      apply();
    }
  });

  /** 把结果落到文档 */
  const apply = (): boolean => {
    if (mode === 'edit') {
      if (!lastEdit || !lastEdit.changes.length) {
        notify.info('没有可应用的改动');
        return false;
      }
      const pending = lastEdit;
      app
        .requireKernel()
        .then(() => {
          app.setFeatures(pending.features, { fit: true });
          notify.ok(`AI 已应用 ${pending.changes.length} 处改动`);
        })
        .catch((e) => notify.err(`应用失败：${(e as Error).message}`));
      return true;
    }

    if (!lastCreate || !lastCreate.compiled.features.length) {
      notify.info('还没有可生成的特征');
      return false;
    }
    const feats = lastCreate.compiled.features;
    app
      .requireKernel()
      .then(() => {
        app.loadFeatures(feats, { replace: true, fit: true });
        notify.ok(`AI 已生成 ${feats.length} 个特征`);
        syncMode();
      })
      .catch((e) => notify.err(`生成失败：${(e as Error).message}`));
    return true;
  };

  const close = modal({
    title: 'AI 建模助手',
    body,
    width: 620,
    actions: [{ label: '关闭' }, { label: '应用', primary: true, onClick: apply }],
  });
  void close;

  syncMode();
  renderHint(
    mode === 'edit'
      ? '在现有模型上继续说：加特征、改尺寸、删特征。'
      : '输入描述后这里会显示解析结果。'
  );
  setTimeout(() => input.focus(), 30);
}

const CHG_LABEL: Record<string, string> = {
  append: '新增',
  resize: '修改',
  delete: '删除',
};

/** 当前模型的类型分布，如「基本体×1 · 孔×1」 */
function summarizeTypes(app: App): string {
  const counter = new Map<string, number>();
  for (const f of app.doc.features) {
    const label = FEATURE_LABELS[f.type] ?? f.type;
    counter.set(label, (counter.get(label) ?? 0) + 1);
  }
  return [...counter.entries()].map(([k, v]) => `${k}×${v}`).join(' · ');
}

const FEATURE_LABELS: Record<string, string> = {
  sketch: '草图',
  extrude: '拉伸',
  revolve: '旋转',
  loft: '放样',
  sweep: '扫描',
  fillet: '圆角',
  chamfer: '倒角',
  shell: '抽壳',
  primitive: '基本体',
  linearPattern: '线性阵列',
  circularPattern: '圆周阵列',
  mirror: '镜像',
  referencePlane: '基准面',
  hole: '孔',
  draft: '拔模',
  rib: '筋',
  spring: '弹簧',
  spiral: '涡状线',
  scale: '缩放',
  split: '分割',
  moveBody: '移动/复制实体',
  deleteBody: '删除实体',
  combine: '组合',
};

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
    width: 620,
    body: el(
      'div',
      { class: 'ai-help' },
      el('div', {
        class: 'ai-help-lead',
        text: '直接用中文描述零件即可，多个动作可用「，」分隔。当前为本地规则解析（离线可用）。',
      }),
      sec('基本体', ['长方体 / 立方体 / 板 / 方块', '圆柱 / 圆盘 / 轴套　　球　　圆锥　　圆环']),
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
      sec('编辑现有模型（切到「编辑当前模型」）', [
        '追加：上面加一个半径8高12的圆柱 ／ 中心开半径8的通孔 ／ 四角倒圆角R3',
        '改尺寸：把高改成20 ／ 把直径改成12 ／ 把长改成80 ／ 把长方体改成80x60x20',
        '指定对象：把长方体的高改成20 ／ 把孔的直径改为6 ／ 把最后一个圆角改成R3',
        '删除：删掉孔 ／ 删掉圆角 ／ 删掉最后一个倒角 ／ 删掉第2个特征',
        '一句话多动作：上面加一个半径8高12的圆柱，把高改成20',
      ]),
      sec('限制', [
        '圆角 / 倒角 / 抽壳 目前只作用于「长方体」（几何引用可解析式算出）',
        '抽壳需要开口面（默认顶面开口）',
        '改尺寸时，挂在被改实体上的孔 / 圆角 / 倒角 / 抽壳会自动跟随新面位置',
      ])
    ),
    actions: [{ label: '知道了', primary: true }],
  });
}
