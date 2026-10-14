/**
 * 热键层单测（纯计算）：
 *   · 键位解析 / 事件 → 文本 / 匹配
 *   · 自定义覆盖存储（localStorage 缺失时退化为内存 Map，Node 下正好测这条）
 *   · 覆盖查找 / 冲突检测 / 恢复默认
 *
 * 与 `hotkeys.ts`（分发器，依赖 DOM）分离，本测试只测 `hotkey-keys.ts`。
 */
import {
  parseKeys,
  eventToKeys,
  keysMatchEvent,
  normalizeKey,
  keyDisplayName,
  isValidKeys,
  hotkeyOverrides,
} from '../src/app/hotkey-keys';

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
function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

console.log('【键位解析】');
check('Ctrl+B → ctrl + B', eq(parseKeys('Ctrl+B'), { ctrl: true, shift: false, alt: false, key: 'B' }));
check('Ctrl+Shift+Z 三修饰', eq(parseKeys('Ctrl+Shift+Z'), { ctrl: true, shift: true, alt: false, key: 'Z' }));
check('Alt+Enter', eq(parseKeys('Alt+Enter'), { ctrl: false, shift: false, alt: true, key: 'ENTER' }));
check('小写 ctrl+b 同样解析', eq(parseKeys('ctrl+b'), { ctrl: true, shift: false, alt: false, key: 'B' }));
check('方向键 ← 作为文本键位保留原样（箭头族由 match 回调处理）', parseKeys('方向键 ←').key === '方向键 ←');
check("' ' 归一化为 SPACE", normalizeKey(' ') === 'SPACE');
check('单字母大写化', normalizeKey('g') === 'G');
check('空串 → 无主键（视为未绑定）', parseKeys('').key === '');
check('纯修饰键 Ctrl → 无主键', parseKeys('Ctrl').key === '');

console.log('\n【事件 → 键位文本】');
check('按 Ctrl+K → "Ctrl+K"', eventToKeys({ key: 'k', ctrlKey: true, shiftKey: false, altKey: false }) === 'Ctrl+K');
check('按 Shift+Ctrl+A → "Ctrl+Shift+A"（修饰符固定顺序）',
  eventToKeys({ key: 'a', ctrlKey: true, shiftKey: true, altKey: false }) === 'Ctrl+Shift+A');
check('按 Alt+Q → "Alt+Q"', eventToKeys({ key: 'q', ctrlKey: false, shiftKey: false, altKey: true }) === 'Alt+Q');
check('按 F5 → null（浏览器保留键）', eventToKeys({ key: 'F5', ctrlKey: false, shiftKey: false, altKey: false }) === null);
check('按 F12 → null', eventToKeys({ key: 'F12', ctrlKey: false, shiftKey: false, altKey: false }) === null);
check('纯按 Ctrl → null', eventToKeys({ key: 'Control', ctrlKey: true, shiftKey: false, altKey: false }) === null);
check('空格 → "Space"', eventToKeys({ key: ' ', ctrlKey: false, shiftKey: false, altKey: false }) === 'Space');
check('F1 可绑定', eventToKeys({ key: 'F1', ctrlKey: false, shiftKey: false, altKey: false }) === 'F1');

console.log('\n【键位 ↔ 事件匹配】');
const ev = (key: string, ctrl = false, shift = false, alt = false) => ({ key, ctrlKey: ctrl, shiftKey: shift, altKey: alt });
check('Ctrl+B 命中', keysMatchEvent('Ctrl+B', ev('b', true)));
check('Ctrl+B 不命中裸 B', !keysMatchEvent('Ctrl+B', ev('b')));
check('Ctrl+B 不命中 Ctrl+Shift+B', !keysMatchEvent('Ctrl+B', ev('b', true, true)));
check('大小写不敏感', keysMatchEvent('Ctrl+B', ev('B', true)));
check('Meta 视同 Ctrl（macOS）', keysMatchEvent('Ctrl+B', { key: 'b', ctrlKey: false, shiftKey: false, altKey: false, metaKey: true }));
check('未绑定（空串）不命中', !keysMatchEvent('', ev('x')));
check('Enter 单键命中', keysMatchEvent('Enter', ev('Enter')));
check('Space 命中空格键', keysMatchEvent('Space', ev(' ')));

console.log('\n【自定义覆盖存储】');
check('初始无覆盖', !hotkeyOverrides.hasAny() && hotkeyOverrides.get('file.new') === null);
hotkeyOverrides.set('file.new', 'Ctrl+Alt+N');
check('设覆盖后可读', hotkeyOverrides.get('file.new') === 'Ctrl+Alt+N');
check('覆盖表含该项', hotkeyOverrides.all()['file.new'] === 'Ctrl+Alt+N');
hotkeyOverrides.set('view.fit', 'Ctrl+Shift+F');
check('多个覆盖并存', Object.keys(hotkeyOverrides.all()).length === 2);
hotkeyOverrides.set('file.new', '');
check('空串 = 移除覆盖', hotkeyOverrides.get('file.new') === null);
check('移除后只剩 1 项', Object.keys(hotkeyOverrides.all()).length === 1);
hotkeyOverrides.reset();
check('reset 清空全部', !hotkeyOverrides.hasAny());

console.log('\n【键位显示名 / 合法性】');
check('SPACE → 空格', keyDisplayName('Space') === '空格');
check('ARROWLEFT → 方向键 ←', keyDisplayName('ArrowLeft') === '方向键 ←');
check('ARROWUP → 方向键 ↑', keyDisplayName('ArrowUp') === '方向键 ↑');
check('合法键位有主键', isValidKeys('Ctrl+K') && isValidKeys('X'));
check('空串非法', !isValidKeys(''));
check('纯修饰键非法', !isValidKeys('Ctrl'));

console.log(`\n热键层单测：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
