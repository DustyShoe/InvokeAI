import { rgbaColorToString } from 'common/util/colorCodeTransformers';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import type { CanvasToolModule } from 'features/controlLayers/konva/CanvasTool/CanvasToolModule';
import { getPrefixedId, isDistanceMoreThanMin, offsetCoord } from 'features/controlLayers/konva/util';
import type { Coordinate } from 'features/controlLayers/store/types';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Logger } from 'roarr';

type CanvasLassoToolModuleConfig = {
  PREVIEW_STROKE_COLOR: string;
  PREVIEW_FILL_COLOR: string;
  PREVIEW_STROKE_WIDTH_PX: number;
  START_POINT_RADIUS_PX: number;
  START_POINT_STROKE_WIDTH_PX: number;
  POLYGON_CLOSE_RADIUS_PX: number;
  MIN_FREEHAND_POINT_DISTANCE_PX: number;
};

const DEFAULT_CONFIG: CanvasLassoToolModuleConfig = {
  PREVIEW_STROKE_COLOR: rgbaColorToString({ r: 90, g: 175, b: 255, a: 1 }),
  PREVIEW_FILL_COLOR: rgbaColorToString({ r: 90, g: 175, b: 255, a: 0.2 }),
  PREVIEW_STROKE_WIDTH_PX: 1.5,
  START_POINT_RADIUS_PX: 4,
  START_POINT_STROKE_WIDTH_PX: 2,
  POLYGON_CLOSE_RADIUS_PX: 10,
  MIN_FREEHAND_POINT_DISTANCE_PX: 1,
};

export class CanvasLassoToolModule extends CanvasModuleBase {
  readonly type = 'lasso_tool';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasToolModule;
  readonly manager: CanvasManager;
  readonly log: Logger;

  config: CanvasLassoToolModuleConfig = DEFAULT_CONFIG;

  private freehandPoints: Coordinate[] = [];
  private polygonPoints: Coordinate[] = [];
  private polygonPointer: Coordinate | null = null;
  private isDrawingFreehand = false;

  konva: {
    group: Konva.Group;
    fillShape: Konva.Line;
    strokeShape: Konva.Line;
    startPointIndicator: Konva.Circle;
  };

  constructor(parent: CanvasToolModule) {
    super();
    this.id = getPrefixedId(this.type);
    this.parent = parent;
    this.manager = this.parent.manager;
    this.path = this.manager.buildPath(this);
    this.log = this.manager.buildLogger(this);
    this.log.debug('Creating module');

    this.konva = {
      group: new Konva.Group({ name: `${this.type}:group`, listening: false }),
      fillShape: new Konva.Line({
        name: `${this.type}:fill_shape`,
        listening: false,
        closed: true,
        fill: this.config.PREVIEW_FILL_COLOR,
        strokeEnabled: false,
        visible: false,
        perfectDrawEnabled: false,
      }),
      strokeShape: new Konva.Line({
        name: `${this.type}:stroke_shape`,
        listening: false,
        closed: false,
        stroke: this.config.PREVIEW_STROKE_COLOR,
        strokeWidth: this.config.PREVIEW_STROKE_WIDTH_PX,
        lineCap: 'round',
        lineJoin: 'round',
        fillEnabled: false,
        visible: false,
        perfectDrawEnabled: false,
      }),
      startPointIndicator: new Konva.Circle({
        name: `${this.type}:start_point_indicator`,
        listening: false,
        fillEnabled: false,
        stroke: this.config.PREVIEW_STROKE_COLOR,
        visible: false,
        perfectDrawEnabled: false,
      }),
    };

    this.konva.group.add(this.konva.fillShape);
    this.konva.group.add(this.konva.strokeShape);
    this.konva.group.add(this.konva.startPointIndicator);
  }

  syncCursorStyle = () => {
    if (!this.parent.getCanDraw()) {
      this.manager.stage.setCursor('not-allowed');
      return;
    }
    this.manager.stage.setCursor('crosshair');
  };

  render = () => {
    const tool = this.parent.$tool.get();
    const isTemporaryViewSwitch = tool === 'view' && this.parent.$toolBuffer.get() === 'lasso';
    if (tool !== 'lasso' && !isTemporaryViewSwitch) {
      this.hidePreview();
      return;
    }

    if (tool === 'lasso') {
      this.syncCursorStyle();
    }
    this.syncPreview();
  };

  onToolChanged = () => {
    const tool = this.parent.$tool.get();
    const isTemporaryViewSwitch = tool === 'view' && this.parent.$toolBuffer.get() === 'lasso';
    if (tool !== 'lasso' && !isTemporaryViewSwitch) {
      this.reset();
    }
  };

  hasActiveSession = (): boolean => {
    return this.isDrawingFreehand || this.freehandPoints.length > 0 || this.polygonPoints.length > 0;
  };

  onStagePointerDown = (e: KonvaEventObject<PointerEvent>) => {
    const cursorPos = this.parent.$cursorPos.get();
    if (!cursorPos) {
      return;
    }

    const lassoMode = this.manager.stateApi.getSettings().lassoMode;
    const point = cursorPos.relative;

    // Keep middle click for pan and right click for context menu.
    if (e.evt.button !== 0) {
      return;
    }

    if (lassoMode === 'freehand') {
      if (!this.parent.$isPrimaryPointerDown.get()) {
        return;
      }

      this.polygonPoints = [];
      this.polygonPointer = null;
      this.freehandPoints = [point];
      this.isDrawingFreehand = true;
      this.syncPreview();
      return;
    }

    this.freehandPoints = [];
    this.isDrawingFreehand = false;

    if (this.polygonPoints.length === 0) {
      this.polygonPoints = [point];
      this.polygonPointer = point;
      this.syncPreview();
      return;
    }

    const startPoint = this.polygonPoints[0];
    if (!startPoint) {
      return;
    }

    if (
      this.polygonPoints.length >= 3 &&
      Math.hypot(point.x - startPoint.x, point.y - startPoint.y) <= this.getPolygonCloseRadius()
    ) {
      this.commitContour(this.polygonPoints);
      this.reset();
      return;
    }

    const snappedPoint = this.getPolygonPoint(point, e.evt.shiftKey);
    this.polygonPoints = [...this.polygonPoints, snappedPoint];
    this.polygonPointer = snappedPoint;
    this.syncPreview();
  };

  onStagePointerMove = (_e: KonvaEventObject<PointerEvent>) => {
    this.handlePointerMove(_e.evt.shiftKey);
  };

  onWindowPointerMove = (e: PointerEvent) => {
    this.handlePointerMove(e.shiftKey);
  };

  onStagePointerUp = (_e: KonvaEventObject<PointerEvent>) => {
    const lassoMode = this.manager.stateApi.getSettings().lassoMode;
    if (lassoMode !== 'freehand' || !this.isDrawingFreehand) {
      return;
    }

    this.commitContour(this.freehandPoints);
    this.reset();
  };

  onWindowPointerUp = () => {
    const lassoMode = this.manager.stateApi.getSettings().lassoMode;
    if (lassoMode !== 'freehand' || !this.isDrawingFreehand) {
      return;
    }

    this.commitContour(this.freehandPoints);
    this.reset();
  };

  reset = () => {
    this.freehandPoints = [];
    this.polygonPoints = [];
    this.polygonPointer = null;
    this.isDrawingFreehand = false;
    this.hidePreview();
  };

  private handlePointerMove = (shouldSnap: boolean) => {
    const cursorPos = this.parent.$cursorPos.get();
    if (!cursorPos) {
      return;
    }

    const lassoMode = this.manager.stateApi.getSettings().lassoMode;
    const point = cursorPos.relative;

    if (lassoMode === 'freehand') {
      if (!this.isDrawingFreehand || !this.parent.$isPrimaryPointerDown.get()) {
        return;
      }

      const minDistance = this.manager.stage.unscale(this.config.MIN_FREEHAND_POINT_DISTANCE_PX);
      const lastPoint = this.freehandPoints.at(-1) ?? null;
      if (!isDistanceMoreThanMin(point, lastPoint, minDistance)) {
        return;
      }
      this.freehandPoints = [...this.freehandPoints, point];
      this.syncPreview();
      return;
    }

    if (this.polygonPoints.length > 0) {
      this.polygonPointer = this.getPolygonPoint(point, shouldSnap);
      this.syncPreview();
    }
  };

  private hidePreview = () => {
    this.konva.strokeShape.visible(false);
    this.konva.fillShape.visible(false);
    this.konva.startPointIndicator.visible(false);
  };

  private syncPreview = () => {
    const lassoMode = this.manager.stateApi.getSettings().lassoMode;
    const stageScale = this.manager.stage.getScale();
    const strokeWidth = this.config.PREVIEW_STROKE_WIDTH_PX / stageScale;

    let points: Coordinate[] = [];
    if (lassoMode === 'freehand') {
      points = this.freehandPoints;
    } else {
      points = [...this.polygonPoints];
      if (this.polygonPointer) {
        points.push(this.polygonPointer);
      }
    }

    if (points.length < 1) {
      this.hidePreview();
      return;
    }

    const flat = points.flatMap((point) => [point.x, point.y]);
    this.konva.strokeShape.setAttrs({
      points: flat,
      strokeWidth,
      visible: true,
    });

    if (points.length >= 3) {
      this.konva.fillShape.setAttrs({
        points: flat,
        visible: true,
      });
    } else {
      this.konva.fillShape.visible(false);
    }

    if (lassoMode === 'polygon' && this.polygonPoints.length > 0) {
      const startPoint = this.polygonPoints[0];
      if (startPoint) {
        this.konva.startPointIndicator.setAttrs({
          x: startPoint.x,
          y: startPoint.y,
          radius: this.manager.stage.unscale(this.config.START_POINT_RADIUS_PX),
          strokeWidth: this.manager.stage.unscale(this.config.START_POINT_STROKE_WIDTH_PX),
          visible: true,
        });
      }
    } else {
      this.konva.startPointIndicator.visible(false);
    }
  };

  private getPolygonCloseRadius = (): number => {
    return this.manager.stage.unscale(this.config.POLYGON_CLOSE_RADIUS_PX);
  };

  private getPolygonPoint = (point: Coordinate, shouldSnap: boolean): Coordinate => {
    if (!shouldSnap) {
      return point;
    }

    const lastPoint = this.polygonPoints.at(-1);
    if (!lastPoint) {
      return point;
    }

    const dx = point.x - lastPoint.x;
    const dy = point.y - lastPoint.y;
    const distance = Math.hypot(dx, dy);

    if (distance === 0) {
      return point;
    }

    const SNAP_ANGLE = Math.PI / 4;
    const angle = Math.atan2(dy, dx);
    const snappedAngle = Math.round(angle / SNAP_ANGLE) * SNAP_ANGLE;

    return {
      x: lastPoint.x + Math.cos(snappedAngle) * distance,
      y: lastPoint.y + Math.sin(snappedAngle) * distance,
    };
  };

  private closeContour = (points: Coordinate[]): Coordinate[] => {
    if (points.length === 0) {
      return [];
    }

    const start = points[0];
    const end = points.at(-1);
    if (!start || !end) {
      return points;
    }

    if (start.x === end.x && start.y === end.y) {
      return points;
    }

    return [...points, start];
  };

  private commitContour = (points: Coordinate[]) => {
    if (points.length < 3) {
      return;
    }

    const closedPoints = this.closeContour(points);
    if (closedPoints.length < 4) {
      return;
    }

    let targetMaskId = this.getActiveInpaintMaskId();
    if (!targetMaskId) {
      this.manager.stateApi.addInpaintMask({ isSelected: true });
      targetMaskId = this.getActiveInpaintMaskId();
    }

    if (!targetMaskId) {
      return;
    }

    const targetMaskState = this.manager.stateApi.getInpaintMasksState().entities.find((entity) => entity.id === targetMaskId);
    if (!targetMaskState) {
      return;
    }

    const normalizedPoints = closedPoints.flatMap((point) => {
      const normalizedPoint = offsetCoord(point, targetMaskState.position);
      return [normalizedPoint.x, normalizedPoint.y];
    });

    this.manager.stateApi.addLasso({
      entityIdentifier: { type: 'inpaint_mask', id: targetMaskId },
      lasso: {
        id: getPrefixedId('lasso'),
        type: 'lasso',
        points: normalizedPoints,
        compositeOperation: this.manager.stateApi.$altKey.get() ? 'destination-out' : 'source-over',
      },
    });
  };

  private getActiveInpaintMaskId = (): string | null => {
    const selectedEntityIdentifier = this.manager.stateApi.getCanvasState().selectedEntityIdentifier;
    if (selectedEntityIdentifier?.type === 'inpaint_mask') {
      return selectedEntityIdentifier.id;
    }

    const inpaintMasks = this.manager.stateApi.getInpaintMasksState().entities;
    const activeMask = inpaintMasks.at(-1);
    return activeMask?.id ?? null;
  };

  repr = () => {
    return {
      id: this.id,
      type: this.type,
      path: this.path,
      freehandPoints: this.freehandPoints,
      polygonPoints: this.polygonPoints,
      polygonPointer: this.polygonPointer,
      isDrawingFreehand: this.isDrawingFreehand,
    };
  };
}
