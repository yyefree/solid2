/**
 * 单位制纯函数单测（对应 src/core/units.ts）。
 * 运行：node tools/run-ts.mjs tools/units-test.ts
 */
import {
  convertLength,
  convertArea,
  convertVolume,
  formatLength,
  formatArea,
  formatVolume,
  fmtCoord,
  trim,
  isUnitSystem,
  UNIT_BY_ID,
  type UnitSystem,
} from '../src/core/units';

let pass = 0;
let fail = 0;
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}  ${extra}`);
  }
}

console.log('单位制换算');
check('MMGS 长度因子 = 1', UNIT_BY_ID.MMGS.length === 1);
check('CGS 长度因子 = 0.1（cm/mm）', near(UNIT_BY_ID.CGS.length, 0.1));
check('IPS 长度因子 = 1/25.4（in/mm）', near(UNIT_BY_ID.IPS.length, 1 / 25.4));

check('convertLength 25.4mm → 1 in', near(convertLength(25.4, 'IPS'), 1));
check('convertLength 10mm → 1 cm', near(convertLength(10, 'CGS'), 1));
check('convertArea 100mm² → 1 cm²', near(convertArea(100, 'CGS'), 1));
check('convertVolume 1000mm³ → 1 cm³', near(convertVolume(1000, 'CGS'), 1));
check('convertVolume 25.4³mm³ → 1 in³', near(convertVolume(25.4 ** 3, 'IPS'), 1, 1e-4));

console.log('格式化');
check('formatLength(25.4, IPS) = "1.0000 in"', formatLength(25.4, 'IPS' as UnitSystem) === '1.0000 in', formatLength(25.4, 'IPS'));
check('formatLength(10, CGS) = "1.000 cm"', formatLength(10, 'CGS') === '1.000 cm', formatLength(10, 'CGS'));
check('formatArea(100, CGS) = "1.000 cm²"', formatArea(100, 'CGS') === '1.000 cm²', formatArea(100, 'CGS'));
check('formatVolume(25.4^3, IPS) 带 in³', formatVolume(25.4 ** 3, 'IPS').endsWith('in³'), formatVolume(25.4 ** 3, 'IPS'));
check('fmtCoord 用长度单位无前缀（紧凑去尾零）', fmtCoord(25.4, 'IPS') === '1', fmtCoord(25.4, 'IPS'));

console.log('工具函数');
check('trim 去尾零', trim(12.3, 4) === '12.3', trim(12.3, 4));
check('trim 全零', trim(0, 3) === '0', trim(0, 3));
check('isUnitSystem 合法', isUnitSystem('MMGS') && isUnitSystem('CGS') && isUnitSystem('IPS'));
check('isUnitSystem 非法', !isUnitSystem('XYZ') && !isUnitSystem(123));

console.log(`\n单位制单测：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
