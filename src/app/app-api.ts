/**
 * AppApi —— UI 层依赖的 App 公共契约（接口缝）。
 *
 * 当前实现为 `Pick<App, AppApiKeys>`：AppApiKeys 是 UI / view / sketch / app 各消费者模块
 * 实际访问的 App 公共成员全集。这样消费者不再直接依赖具体的 `App` 类（符号解耦），
 * 而只依赖这份命名契约；`App implements AppApi` 由编译器强制保证「类满足契约」。
 *
 * 后续把 App 按领域拆分时，只需让新的实现继续满足 `AppApi`（或把本文件替换为
 * 真正自有的 interface，签名从 App 的公开声明搬运），消费者无需改动。
 */
import type { App } from './app';

type AppApiKeys =
  'activateDocument' |
  'activeDocId' |
  'activeSketchFeature' |
  'addDrawingView' |
  'addFeature' |
  'appearanceHex' |
  'applyDrawingDimMeta' |
  'assembly' |
  'assemblyPicks' |
  'autoDimensionDrawing' |
  'autoHoleDimensionDrawing' |
  'canRedo' |
  'canUndo' |
  'clearAssemblyPicks' |
  'clearDrawingDims' |
  'clearSelection' |
  'closeActiveDocument' |
  'closeDocument' |
  'copySelection' |
  'currentBBox' |
  'currentModel' |
  'cutSelection' |
  'cycleDocument' |
  'deleteSelection' |
  'dimMode' |
  'displayStyle' |
  'doc' |
  'documents' |
  'drawing' |
  'drawingHost' |
  'editingSketch' |
  'emit' |
  'ensureAssembly' |
  'enterSketch' |
  'escape' |
  'exitSketch' |
  'exportDrawingPNG' |
  'exportObj' |
  'exportStep' |
  'exportStl' |
  'featureExpressionRows' |
  'featureNumericParams' |
  'firstErrorFeatureId' |
  'forceRebuild' |
  'generateDrawing' |
  'hasModel' |
  'importStepFile' |
  'kernelReady' |
  'lightPreset' |
  'loadFeatures' |
  'mode' |
  'modelSummary' |
  'newDocument' |
  'normalToSelection' |
  'on' |
  'openProject' |
  'panView' |
  'paramRows' |
  'pasteFromClipboard' |
  'pickCandidateFaces' |
  'placeDrawingDimension' |
  'planeOfSketch' |
  'prevView' |
  'previewExpr' |
  'printView' |
  'projection' |
  'realView' |
  'rebuild' |
  'rebuildModel' |
  'redo' |
  'redraw' |
  'referenceCandidates' |
  'refreshDrawing' |
  'removeDrawingDim' |
  'removeFeature' |
  'removeFeatureExpression' |
  'removeParam' |
  'requireKernel' |
  'resolvedFeatures' |
  'rotateView' |
  'saveProject' |
  'sceneName' |
  'sectionAxis' |
  'selectAll' |
  'selectFace' |
  'selectFeature' |
  'selectedEdgeInfos' |
  'selectedFaceInfos' |
  'selectedFeatureId' |
  'selectedVertexPoints' |
  'selection' |
  'selectionFilter' |
  'setAppearance' |
  'setDisplayStyle' |
  'setFeatureExpression' |
  'setFeatures' |
  'setLightPreset' |
  'setMode' |
  'setParam' |
  'setProjection' |
  'setRealView' |
  'setScene' |
  'setSection' |
  'setSelectionFilter' |
  'setSketchTool' |
  'setStatus' |
  'setUnitSystem' |
  'setView' |
  'setViewportLayout' |
  'shapeView' |
  'showGrid' |
  'showMassProperties' |
  'showOrigin' |
  'showPlanes' |
  'showProperties' |
  'showSectionProperties' |
  'sketch' |
  'sketchPlane' |
  'sketchTool' |
  'startSketch' |
  'status' |
  'syncAssemblyScene' |
  'toggleDimensionMode' |
  'toggleDrawingBOM' |
  'toggleGrid' |
  'toggleOrigin' |
  'togglePlanes' |
  'toggleSection' |
  'toggleTabVisibility' |
  'toggleSuppress' |
  'moveFeature' |
  'renameFeature' |
  'undo' |
  'unitSystem' |
  'updateFeatureParams' |
  'viewport' |
  'viewportLayout' |
  'zoomArea' |
  'zoomFit' |
  'zoomIn' |
  'zoomOut'
;

export type AppApi = Pick<App, AppApiKeys>;
