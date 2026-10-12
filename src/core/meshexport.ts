/**
 * 纯网格导出 + 浏览器文件助手（不依赖几何内核）。
 *
 * STL / OBJ 的写入只用到三角网格的 positions / indices / normals，
 * 因此放主线程即可——这些数据来自内核 Worker 的 MeshResult，无需再回 Worker。
 * STEP 的导入导出在 `io.ts`（需要 OCCT，仅 Worker 调用）。
 */
export interface PlainMesh {
  positions: Float32Array | number[];
  indices: Uint32Array | number[];
  normals?: Float32Array | number[];
}

export function exportSTLBinary(mesh: PlainMesh): ArrayBuffer {
  const tris = (mesh.indices.length / 3) | 0;
  const buf = new ArrayBuffer(84 + tris * 50);
  const view = new DataView(buf);
  const header = 'Solid2 binary STL export';
  for (let i = 0; i < 80; i++) view.setUint8(i, i < header.length ? header.charCodeAt(i) : 0x20);
  view.setUint32(80, tris, true);

  const p = mesh.positions;
  const idx = mesh.indices;
  let off = 84;
  for (let t = 0; t < tris; t++) {
    const i0 = idx[t * 3] * 3, i1 = idx[t * 3 + 1] * 3, i2 = idx[t * 3 + 2] * 3;
    const ux = p[i1] - p[i0], uy = p[i1 + 1] - p[i0 + 1], uz = p[i1 + 2] - p[i0 + 2];
    const vx = p[i2] - p[i0], vy = p[i2 + 1] - p[i0 + 1], vz = p[i2 + 2] - p[i0 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    view.setFloat32(off, nx, true); view.setFloat32(off + 4, ny, true); view.setFloat32(off + 8, nz, true);
    off += 12;
    for (const ii of [i0, i1, i2]) {
      view.setFloat32(off, p[ii], true);
      view.setFloat32(off + 4, p[ii + 1], true);
      view.setFloat32(off + 8, p[ii + 2], true);
      off += 12;
    }
    view.setUint16(off, 0, true);
    off += 2;
  }
  return buf;
}

export function exportSTLAscii(mesh: PlainMesh, name = 'solid2'): string {
  const p = mesh.positions;
  const idx = mesh.indices;
  const lines: string[] = [`solid ${name}`];
  for (let t = 0; t < idx.length / 3; t++) {
    const i0 = idx[t * 3] * 3, i1 = idx[t * 3 + 1] * 3, i2 = idx[t * 3 + 2] * 3;
    const ux = p[i1] - p[i0], uy = p[i1 + 1] - p[i0 + 1], uz = p[i1 + 2] - p[i0 + 2];
    const vx = p[i2] - p[i0], vy = p[i2 + 1] - p[i0 + 1], vz = p[i2 + 2] - p[i0 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    lines.push(`  facet normal ${nx} ${ny} ${nz}`);
    lines.push('    outer loop');
    for (const ii of [i0, i1, i2]) lines.push(`      vertex ${p[ii]} ${p[ii + 1]} ${p[ii + 2]}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push(`endsolid ${name}`);
  return lines.join('\n');
}

export function exportOBJ(mesh: PlainMesh, name = 'solid2'): string {
  const p = mesh.positions;
  const n = mesh.normals ?? p;
  const lines: string[] = [`# Solid2 OBJ export`, `o ${name}`];
  for (let i = 0; i < p.length; i += 3) lines.push(`v ${p[i]} ${p[i + 1]} ${p[i + 2]}`);
  for (let i = 0; i < n.length; i += 3) lines.push(`vn ${n[i]} ${n[i + 1]} ${n[i + 2]}`);
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const a = mesh.indices[t * 3] + 1, b = mesh.indices[t * 3 + 1] + 1, c = mesh.indices[t * 3 + 2] + 1;
    lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
  }
  return lines.join('\n');
}

export function download(data: string | ArrayBuffer | Uint8Array, filename: string, mime = 'application/octet-stream') {
  const blob = typeof data === 'string'
    ? new Blob([data], { type: mime })
    : new Blob([data as any], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}
