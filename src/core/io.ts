/**
 * STEP 导入导出（需要 OpenCASCADE，仅内核 Worker 调用）。
 *
 * 见文件头说明 2：路径必须 ≤10 字符。
 * 纯网格导出（STL/OBJ）与浏览器文件助手在 `meshexport.ts`（主线程可用，无 OCCT）。
 */
import { oc } from './occt';
import type { Shape } from './solid';

// 见文件头说明 2：路径必须 ≤10 字符
const EXPORT_STEP_PATH = '/o.step';
const IMPORT_STEP_PATH = '/i.step';

export function exportSTEP(shape: Shape): Uint8Array {
  const o = oc();
  const path = EXPORT_STEP_PATH;
  const w = new o.STEPControl_Writer_1();
  w.Transfer(shape, o.STEPControl_StepModelType.STEPControl_AsIs, true);
  w.Write(path);
  let bytes: Uint8Array;
  try {
    bytes = o.FS.readFile(path);
  } catch {
    throw new Error('STEP 导出失败：虚拟文件系统中未生成文件（路径过长？）');
  }
  try {
    o.FS.unlink(path);
  } catch {
    /* 忽略清理失败 */
  }
  if (!bytes || !bytes.length) throw new Error('STEP 导出失败：未产生数据');
  return bytes;
}

export function importSTEP(bytes: Uint8Array | ArrayBuffer): Shape {
  const o = oc();
  const path = IMPORT_STEP_PATH;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  o.FS.writeFile(path, u8);
  const r = new o.STEPControl_Reader_1();
  r.ReadFile(path);
  const n = r.NbRootsForTransfer();
  if (!n) throw new Error('STEP 导入失败：文件中没有可转换的实体');
  r.TransferRoots();
  const shape = r.OneShape();
  try {
    o.FS.unlink(path);
  } catch {
    /* 忽略 */
  }
  if (!shape || shape.IsNull()) throw new Error('STEP 导入失败：几何为空');
  return shape;
}
