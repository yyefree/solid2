/**
 * 文件服务（App 领域拆分之三，与 selection-store / undo-manager / param-service 同构）。
 *
 * 从 `App` 抽出的文件领域：导出（STEP / STL / OBJ）、项目保存 / 打开、STEP 导入。
 *
 * 环境能力（DOM / 内核 Worker）全部经宿主回调注入——本类自身不 import `kernel`
 * （其构造器即建 Worker，Node 下不可导入）也不直接碰 DOM → 纯编排逻辑，
 * 可在 Node 下单测（见 tools/file-service-test.ts）。
 */

import type { Feature } from '../doc/types';
import type {
  BBox,
  ExportResult,
  ImportResult,
  MeshResult,
  ModelResult,
} from '../core/kernel-types';
import { exportSTLBinary, exportOBJ } from '../core/meshexport';
import { viewsOfMesh } from '../core/kernel-types';

/** 文件服务需要的宿主能力（由 App 提供；含 DOM / 内核 Worker 等环境依赖） */
export interface FileHost {
  /** 是否有可导出的实体 */
  hasModel(): boolean;
  /** 解析后的特征（发给内核/导出必须用它——内核只认数值，不认表达式） */
  resolvedFeatures(): Feature[];
  /** 当前文档的序列化 JSON（保存用；含缩进格式） */
  documentJSON(): string;
  /** 整体替换文档（打开项目；App 内部走 mutate 压栈 + 重建 + 适配视图） */
  loadDocument(data: unknown): void;
  /** 把当前状态写回文档条目（打开/导入后同步） */
  syncEntry(): void;
  /** 记录导入的 STEP 模型（importedModel 生效 / model 清空 + 条目同步） */
  setImportedModel(model: ModelResult): void;
  /** 用导入的网格重建三维显示（替换 shapeView + 适配视图） */
  showImportedMesh(mesh: MeshResult, bbox: BBox): void;
  /** 内核：导出 STEP → 字节 */
  exportStep(features: Feature[]): Promise<ExportResult>;
  /** 内核：三角化（STL / OBJ 导出的网格质量由宿主固定） */
  tessellate(features: Feature[]): Promise<ModelResult>;
  /** 内核：导入 STEP → 网格 */
  importStep(bytes: ArrayBuffer): Promise<ImportResult>;
  /** 触发浏览器下载 */
  download(content: string | Uint8Array | ArrayBuffer, filename: string, mime: string): void;
  /** 选择文本文件（取消返回 null） */
  pickText(accept: string): Promise<{ name: string; text: string } | null>;
  /** 选择二进制文件（取消返回 null） */
  pickBinary(accept: string): Promise<{ name: string; buffer: ArrayBuffer } | null>;
  /** 轻提示 */
  toast(kind: 'ok' | 'err', msg: string): void;
}

export class FileService {
  constructor(private readonly host: FileHost) {}

  // ---- 导出 ----

  async exportStep(): Promise<void> {
    if (!this.host.hasModel()) {
      this.host.toast('err', '没有可导出的实体');
      return;
    }
    try {
      const r = await this.host.exportStep(this.host.resolvedFeatures());
      this.host.download(new Uint8Array(r.bytes), 'solid2.step', 'application/step');
      this.host.toast('ok', `STEP 导出成功（${(r.bytes.byteLength / 1024).toFixed(1)} KB）`);
    } catch (e) {
      this.host.toast('err', `STEP 导出失败：${(e as Error).message}`);
    }
  }

  async exportStl(): Promise<void> {
    if (!this.host.hasModel()) {
      this.host.toast('err', '没有可导出的实体');
      return;
    }
    try {
      const m = await this.host.tessellate(this.host.resolvedFeatures());
      const mesh = viewsOfMesh(m.mesh);
      const buf = exportSTLBinary(mesh);
      this.host.download(buf, 'solid2.stl', 'model/stl');
      this.host.toast('ok', `STL 导出成功（${mesh.indices.length / 3} 三角形）`);
    } catch (e) {
      this.host.toast('err', `STL 导出失败：${(e as Error).message}`);
    }
  }

  async exportObj(): Promise<void> {
    if (!this.host.hasModel()) {
      this.host.toast('err', '没有可导出的实体');
      return;
    }
    try {
      const m = await this.host.tessellate(this.host.resolvedFeatures());
      const mesh = viewsOfMesh(m.mesh);
      this.host.download(exportOBJ(mesh), 'solid2.obj', 'model/obj');
      this.host.toast('ok', 'OBJ 导出成功');
    } catch (e) {
      this.host.toast('err', `OBJ 导出失败：${(e as Error).message}`);
    }
  }

  // ---- 项目保存 / 打开 ----

  saveProject(): void {
    this.host.download(this.host.documentJSON(), 'solid2-model.json', 'application/json');
    this.host.toast('ok', '项目已保存');
  }

  async openProject(): Promise<void> {
    const file = await this.host.pickText('.json,.solid2');
    if (!file) return;
    try {
      const data = JSON.parse(file.text);
      this.host.loadDocument(data);
      this.host.syncEntry();
      this.host.toast('ok', `已打开：${file.name}`);
    } catch (e) {
      this.host.toast('err', `打开失败：${(e as Error).message}`);
    }
  }

  // ---- STEP 导入 ----

  async importStepFile(): Promise<void> {
    const file = await this.host.pickBinary('.step,.stp');
    if (!file) return;
    try {
      const r = await this.host.importStep(file.buffer);
      // 导入体无特征级错误 → errors 空、rebuildMs 记 0（与原 App 行为一致）
      this.host.setImportedModel({ mesh: r.mesh, bbox: r.bbox, stats: r.stats, errors: [], rebuildMs: 0 });
      this.host.showImportedMesh(r.mesh, r.bbox);
      this.host.toast('ok', `已导入 ${file.name}`);
    } catch (e) {
      this.host.toast('err', `导入失败：${(e as Error).message}`);
    }
  }
}
