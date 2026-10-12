/**
 * 浏览器端 OpenCASCADE 加载器（懒加载 + 流式进度）。
 *
 * 关键点：
 *  - 用 `?url` 把 wasm 作为静态资源引入，避免 Vite 解析 wasm 模块；
 *  - 自己用 fetch 流式下载，报告真实字节进度（0 → 80%）；
 *  - 再把 ArrayBuffer 交给 emscripten 编译/实例化（80 → 100%）；
 *  - 加载成功后自动 setOcct，所有消费者拿到的是同一个单例 Promise。
 *
 * ⚠️ 关于"65MB 内存限制"：那 63MB 是编译后的 wasm 二进制（下载+解析+实例化开销），
 *    不是堆上限。emscripten 已配 `maximum: 2GB` 且开启 ALLOW_MEMORY_GROWTH，
 *    线性内存会随几何数据量自动增长。这里做的是把"阻塞启动的下载/编译"移出主路径，
 *    让界面先出来、内核后台加载并展示进度。
 */
// @ts-ignore emscripten 胶水无类型声明
import opencascadeFactory from 'opencascade.js/dist/opencascade.wasm.js';
// @ts-ignore Vite 资源导入
import wasmUrl from 'opencascade.js/dist/opencascade.wasm.wasm?url';
import { setOcct } from './occt';

export type KernelProgress = (pct: number, phase: string) => void;

let kernelPromise: Promise<any> | null = null;

function fmtMB(n: number): string {
  return `${(n / 1048576).toFixed(1)} MB`;
}

async function doLoad(onProgress?: KernelProgress): Promise<any> {
  const report = (pct: number, phase: string) =>
    onProgress?.(Math.max(0, Math.min(100, pct)), phase);

  report(2, '连接几何内核…');

  // ---------- 1) 流式下载 wasm，带真实字节进度 ----------
  const resp = await fetch(wasmUrl);
  if (!resp.ok) throw new Error(`几何内核下载失败 HTTP ${resp.status}`);

  const total = Number(resp.headers.get('content-length')) || 65 * 1024 * 1024;
  let wasmBinary: Uint8Array;

  const body: any = resp.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    report(5, `下载内核 ${fmtMB(0)} / ${fmtMB(total)}`);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      report(5 + (received / total) * 75, `下载内核 ${fmtMB(received)} / ${fmtMB(total)}`);
    }
    wasmBinary = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) {
      wasmBinary.set(c, off);
      off += c.length;
    }
  } else {
    // 退化路径：无法流式读取时一次性取回
    wasmBinary = new Uint8Array(await resp.arrayBuffer());
    report(80, `内核已下载 ${fmtMB(wasmBinary.byteLength)}`);
  }

  // ---------- 2) 编译 + 实例化（纯 CPU，无网络） ----------
  report(82, '编译内核…');
  const oc = await opencascadeFactory({
    wasmBinary: wasmBinary as any,
    locateFile(path: string) {
      if (path.endsWith('.wasm')) return wasmUrl;
      return path;
    },
  });

  // 内核就绪后写入全局，oc() 即可用
  setOcct(oc);
  report(100, '几何内核就绪');
  return oc;
}

/**
 * 启动 / 获取内核加载。单例：重复调用返回同一个 Promise，
 * 进度回调只在首次调用时生效（后续调用忽略 onProgress）。
 */
export function loadKernel(onProgress?: KernelProgress): Promise<any> {
  if (!kernelPromise) kernelPromise = doLoad(onProgress);
  return kernelPromise;
}

/** 兼容旧调用点。 */
export function initOpenCascade(onProgress?: KernelProgress): Promise<any> {
  return loadKernel(onProgress);
}
