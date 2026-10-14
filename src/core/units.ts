/**
 * 单位制（SolidWorks → 工具 > 选项 > 文档属性 > 单位）。
 *
 * 内核与几何始终以 **毫米 (mm)** 为内部基准。本模块只负责把 mm 换算成当前
 * 单位制下的显示值与单位后缀，所有「只读读出值」（状态栏坐标、测量、质量属性、
 * 模型信息、工程图尺寸、干涉体积）都经这里格式化，保证全界面单位一致。
 *
 * 纯模块（不 import DOM / 内核 / three），与 `sketch/curve.ts` 同惯例，可单测。
 */
export type UnitSystem = 'MMGS' | 'CGS' | 'IPS';

export interface UnitDef {
  id: UnitSystem;
  /** 状态栏显示的名称（SW 同样在状态栏显示单位系统） */
  label: string;
  /** 长度换算因子：显示长度 = mm × length */
  length: number;
  lenUnit: string;
  areaUnit: string;
  volUnit: string;
  /** 各量保留的小数位数 */
  digits: { len: number; area: number; vol: number };
}

export const UNIT_SYSTEMS: UnitDef[] = [
  { id: 'MMGS', label: 'MMGS', length: 1, lenUnit: 'mm', areaUnit: 'mm²', volUnit: 'mm³', digits: { len: 3, area: 2, vol: 3 } },
  { id: 'CGS', label: 'CGS', length: 0.1, lenUnit: 'cm', areaUnit: 'cm²', volUnit: 'cm³', digits: { len: 3, area: 3, vol: 4 } },
  { id: 'IPS', label: 'IPS', length: 1 / 25.4, lenUnit: 'in', areaUnit: 'in²', volUnit: 'in³', digits: { len: 4, area: 4, vol: 5 } },
];

export const UNIT_BY_ID: Record<UnitSystem, UnitDef> = UNIT_SYSTEMS.reduce(
  (acc, u) => ((acc[u.id] = u), acc),
  {} as Record<UnitSystem, UnitDef>
);

/** 默认 / 兜底单位制 */
export const DEFAULT_UNIT: UnitSystem = 'MMGS';

export function isUnitSystem(x: unknown): x is UnitSystem {
  return x === 'MMGS' || x === 'CGS' || x === 'IPS';
}

/** 去除尾随零与多余小数点（用于坐标等紧凑显示） */
export function trim(n: number, digits: number): string {
  if (!Number.isFinite(n)) return '—';
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  // 避免 1e-7 这类科学计数法
  const s = Math.abs(r) < 1e-9 ? '0' : String(r);
  return s;
}

/** 固定小数位（保留尾随零，用于带单位的读出值，体现精度） */
export function fix(n: number, digits: number): string {
  if (!Number.isFinite(n)) return '—';
  const s = Math.round(n * 10 ** digits) / 10 ** digits;
  if (Math.abs(s) < 1e-9) return '0.' + '0'.repeat(digits);
  // 手动拼固定小数位，避免 toFixed 的科学计数法
  const neg = s < 0;
  const abs = Math.abs(s);
  const intp = Math.floor(abs);
  const frac = Math.round((abs - intp) * 10 ** digits);
  let fracStr = String(frac);
  while (fracStr.length < digits) fracStr = '0' + fracStr;
  const intStr = String(intp);
  return (neg ? '-' : '') + intStr + '.' + fracStr;
}

export function convertLength(mm: number, sys: UnitSystem): number {
  return mm * UNIT_BY_ID[sys].length;
}
export function convertArea(mm2: number, sys: UnitSystem): number {
  const f = UNIT_BY_ID[sys].length;
  return mm2 * f * f;
}
export function convertVolume(mm3: number, sys: UnitSystem): number {
  const f = UNIT_BY_ID[sys].length;
  return mm3 * f * f * f;
}

/** 长度值 + 单位，如 `12.340 mm` / `0.4859 in` */
export function formatLength(mm: number, sys: UnitSystem): string {
  const u = UNIT_BY_ID[sys];
  return `${fix(convertLength(mm, sys), u.digits.len)} ${u.lenUnit}`;
}
/** 面积值 + 单位 */
export function formatArea(mm2: number, sys: UnitSystem): string {
  const u = UNIT_BY_ID[sys];
  return `${fix(convertArea(mm2, sys), u.digits.area)} ${u.areaUnit}`;
}
/** 体积值 + 单位 */
export function formatVolume(mm3: number, sys: UnitSystem): string {
  const u = UNIT_BY_ID[sys];
  return `${fix(convertVolume(mm3, sys), u.digits.vol)} ${u.volUnit}`;
}

/** 惯性矩（长度⁴）值 + 单位 */
export function formatInertia(mm4: number, sys: UnitSystem): string {
  const u = UNIT_BY_ID[sys];
  return `${fix(convertVolume(mm4, sys), u.digits.vol + 1)} ${u.volUnit.replace('³', '⁴')}`;
}

/** 仅数值（用于坐标等已自带上下文的位置） */
export function fmtCoord(mm: number, sys: UnitSystem): string {
  return trim(convertLength(mm, sys), UNIT_BY_ID[sys].digits.len);
}
