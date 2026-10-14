/**
 * 热键纯计算层：键位解析、事件 → 文本、自定义覆盖存储。
 *
 * 与 `hotkeys.ts`（分发器 + 默认键位表）分离，本模块**不 import DOM / UI / 内核**，
 * 可在 Node 下单测（`tools/hotkeys-test.ts`）。
 *
 * SolidWorks「工具 → 自定义 → 键盘」的对应实现：
 *   · 每个命令的快捷键可重映射，存 localStorage（`solid2.hotkeys.v1`）；
 *   · 分发与菜单文本都读同一份覆盖（`hotkeyOverrides.get(id) ?? 默认键`）；
 *   · Node 环境没有 localStorage 时自动退化为进程内 Map（测试用）。
 */

/** 解析后的键位（修饰符 + 主键，主键统一大写） */
export interface ParsedKey {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** 把 'Ctrl+Shift+K' / '方向键 ←' / ' ' 归一化成主键 */
export function normalizeKey(k: string): string {
  if (k === ' ') return 'SPACE';
  return k.toUpperCase();
}

export function parseKeys(keys: string): ParsedKey {
  const p: ParsedKey = { ctrl: false, shift: false, alt: false, key: '' };
  for (const raw of keys.split('+')) {
    const s = raw.trim();
    if (!s) continue;
    const low = s.toLowerCase();
    if (low === 'ctrl' || low === 'cmd' || low === 'meta') p.ctrl = true;
    else if (low === 'shift') p.shift = true;
    else if (low === 'alt') p.alt = true;
    else p.key = normalizeKey(s);
  }
  return p;
}

/** 主键显示名（'SPACE' → '空格'） */
export function keyDisplayName(key: string): string {
  const k = normalizeKey(key);
  if (k === 'SPACE') return '空格';
  if (k.startsWith('ARROW')) return `方向键 ${k === 'ARROWLEFT' ? '←' : k === 'ARROWRIGHT' ? '→' : k === 'ARROWUP' ? '↑' : '↓'}`;
  return key;
}

/**
 * KeyboardEvent → 规范化键位文本（'Ctrl+Shift+K'）。
 * 只收 Ctrl/Shift/Alt 组合与单键；忽略纯修饰键按下与 F5/F12 等浏览器保留键。
 */
export function eventToKeys(e: {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
}): string | null {
  const k = e.key;
  if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return null;
  if (k === 'F5' || k === 'F12') return null; // 浏览器保留
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const main = k === ' ' ? 'Space' : k.length === 1 ? k.toUpperCase() : k;
  parts.push(main);
  return parts.join('+');
}

/** 键位文本是否匹配事件（覆盖后的「当前键」走这里） */
export function keysMatchEvent(keys: string, e: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey?: boolean }): boolean {
  const p = parseKeys(keys);
  if (!p.key) return false;
  if (p.ctrl !== !!(e.ctrlKey || e.metaKey)) return false;
  if (p.alt !== !!e.altKey) return false;
  if (p.shift !== !!e.shiftKey) return false;
  return normalizeKey(e.key) === p.key;
}

/** 键位是否合法（有主键、且不是纯修饰键） */
export function isValidKeys(keys: string): boolean {
  const p = parseKeys(keys);
  return !!p.key;
}

// ============================================================
// 覆盖存储
// ============================================================

export interface OverrideStore {
  /** 取某命令的覆盖键位；无覆盖返回 null */
  get(id: string): string | null;
  /** 设覆盖（keys 为空串 = 移除覆盖，回默认） */
  set(id: string, keys: string): void;
  /** 清空全部覆盖（恢复默认） */
  reset(): void;
  /** 全量覆盖表（命令 id → 键位文本） */
  all(): Record<string, string>;
  /** 是否有覆盖 */
  hasAny(): boolean;
}

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const OVERRIDE_KEY = 'solid2.hotkeys.v1';
const memory = new Map<string, string>();

function localStorageLike(): StorageLike | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      // 探测可用性（部分隐私模式 setItem 会抛）
      localStorage.setItem('__solid2_probe__', '1');
      localStorage.removeItem('__solid2_probe__');
      return localStorage;
    }
  } catch {
    /* 退化到内存 */
  }
  return null;
}

/** 进程级单例；Node 测试环境自动用内存 Map */
export const hotkeyOverrides: OverrideStore = (() => {
  const store = localStorageLike();
  return {
    get(id) {
      if (store) {
        try {
          const raw = JSON.parse(store.getItem(OVERRIDE_KEY) ?? '{}') as Record<string, string>;
          return raw[id] ?? null;
        } catch {
          return null;
        }
      }
      return memory.get(id) ?? null;
    },
    set(id, keys) {
      const cur: Record<string, string> = { ...this.all() };
      if (!keys) delete cur[id];
      else cur[id] = keys;
      if (store) store.setItem(OVERRIDE_KEY, JSON.stringify(cur));
      else {
        memory.clear();
        for (const [k, v] of Object.entries(cur)) memory.set(k, v);
      }
    },
    reset() {
      if (store) store.removeItem(OVERRIDE_KEY);
      else memory.clear();
    },
    all() {
      if (store) {
        try {
          return JSON.parse(store.getItem(OVERRIDE_KEY) ?? '{}') as Record<string, string>;
        } catch {
          return {};
        }
      }
      return Object.fromEntries(memory);
    },
    hasAny() {
      return Object.keys(this.all()).length > 0;
    },
  };
})();
