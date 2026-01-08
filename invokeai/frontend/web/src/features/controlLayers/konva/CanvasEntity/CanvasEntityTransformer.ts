import { Mutex } from 'async-mutex';
import { withResult, withResultAsync } from 'common/util/result';
import { roundToMultiple } from 'common/util/roundDownToMultiple';
import { clamp, debounce, get } from 'es-toolkit/compat';
import type { CanvasEntityAdapter } from 'features/controlLayers/konva/CanvasEntity/types';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import {
  areStageAttrsGonnaExplode,
  canvasToImageData,
  getEmptyRect,
  getKonvaNodeDebugAttrs,
  getPrefixedId,
  offsetCoord,
  roundRect,
} from 'features/controlLayers/konva/util';
import { selectSelectedEntityIdentifier } from 'features/controlLayers/store/selectors';
import type { Coordinate, LifecycleCallback, Rect, RectWithRotation } from 'features/controlLayers/store/types';
import { toast } from 'features/toast/toast';
import Konva from 'konva';
import type { GroupConfig } from 'konva/lib/Group';
import { atom } from 'nanostores';
import type { Logger } from 'roarr';
import { serializeError } from 'serialize-error';
import type { ImageDTO } from 'services/api/types';
import { assert } from 'tsafe';

type CanvasEntityTransformerConfig = {
  /**
   * The debounce time in milliseconds for calculating the rect of the parent entity
   */
  RECT_CALC_DEBOUNCE_MS: number;
  /**
   * The padding around the scaling transform anchors for hit detection
   */
  ANCHOR_HIT_PADDING: number;
  /**
   * The padding around the parent entity when drawing the rect outline
   */
  OUTLINE_PADDING: number;
  /**
   * The color of the rect outline
   */
  OUTLINE_COLOR: string;
  /**
   * The fill color of the scaling transform anchors
   */
  SCALE_ANCHOR_FILL_COLOR: string;
  /**
   * The stroke color of the scaling transform anchors
   */
  SCALE_ANCHOR_STROKE_COLOR: string;
  /**
   * The corner radius ratio of the scaling transform anchors
   */
  SCALE_ANCHOR_CORNER_RADIUS_RATIO: number;
  /**
   * The stroke width of the scaling transform anchors
   */
  SCALE_ANCHOR_STROKE_WIDTH: number;
  /**
   * The size of the scaling transform anchors
   */
  SCALE_ANCHOR_SIZE: number;
  /**
   * The fill color of the rotation transform anchor
   */
  ROTATE_ANCHOR_FILL_COLOR: string;
  /**
   * The stroke color of the rotation transform anchor
   */
  ROTATE_ANCHOR_STROKE_COLOR: string;
  /**
   * The size (height/width) of the rotation transform anchor
   */
  ROTATE_ANCHOR_SIZE: number;
};

type TransformMode = 'affine' | 'warp';

type WarpCorners = {
  tl: Coordinate;
  tr: Coordinate;
  br: Coordinate;
  bl: Coordinate;
};

type WarpSide = 'tm' | 'mr' | 'bm' | 'ml';

const DEFAULT_CONFIG: CanvasEntityTransformerConfig = {
  RECT_CALC_DEBOUNCE_MS: 300,
  ANCHOR_HIT_PADDING: 10,
  OUTLINE_PADDING: 0,
  OUTLINE_COLOR: 'hsl(200 76% 50% / 1)', // invokeBlue.500
  SCALE_ANCHOR_FILL_COLOR: 'hsl(200 76% 50% / 1)', // invokeBlue.500
  SCALE_ANCHOR_STROKE_COLOR: 'hsl(200 76% 77% / 1)', // invokeBlue.200
  SCALE_ANCHOR_CORNER_RADIUS_RATIO: 0.5,
  SCALE_ANCHOR_STROKE_WIDTH: 2,
  SCALE_ANCHOR_SIZE: 8,
  ROTATE_ANCHOR_FILL_COLOR: 'hsl(200 76% 95% / 1)', // invokeBlue.50
  ROTATE_ANCHOR_STROKE_COLOR: 'hsl(200 76% 40% / 1)', // invokeBlue.700
  ROTATE_ANCHOR_SIZE: 12,
};

export class CanvasEntityTransformer extends CanvasModuleBase {
  readonly type = 'entity_transformer';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasEntityAdapter;
  readonly manager: CanvasManager;
  readonly log: Logger;

  config: CanvasEntityTransformerConfig = DEFAULT_CONFIG;

  /**
   * The rect of the parent, _including_ transparent regions, **relative to the parent's position**. To get the rect
   * relative to the _stage_, add the parent's position.
   *
   * It is calculated via Konva's getClientRect method, which is fast but includes transparent regions.
   *
   * This rect is relative _to the parent's position_, not the stage.
   */
  $nodeRect = atom<Rect>(getEmptyRect());

  /**
   * The rect of the parent, _excluding_ transparent regions, **relative to the parent's position**. To get the rect
   * relative to the _stage_, add the parent's position.
   *
   * If the parent's nodes have no possibility of transparent regions, this will be calculated the same way as nodeRect.
   *
   * If the parent's nodes may have transparent regions, this will be calculated manually by rasterizing the parent and
   * checking the pixel data.
   */
  $pixelRect = atom<Rect>(getEmptyRect());

  /**
   * Whether the transformer is currently calculating the rect of the parent.
   */
  $isPendingRectCalculation = atom<boolean>(false);

  /**
   * A set of subscriptions that should be cleaned up when the transformer is destroyed.
   */
  subscriptions: Set<() => void> = new Set();

  /**
   * Whether the transformer is currently transforming the entity.
   */
  $isTransforming = atom<boolean>(false);

  /**
   * The current transform mode.
   */
  $transformMode = atom<TransformMode>('affine');

  /**
   * The current interaction mode of the transformer:
   * - 'all': The entity can be moved, resized, and rotated.
   * - 'drag': The entity can be moved.
   * - 'off': The transformer is not interactable.
   */
  $interactionMode = atom<'all' | 'drag' | 'off'>('off');

  /**
   * Whether dragging is enabled. Dragging is enabled in both 'all' and 'drag' interaction modes.
   */
  $isDragEnabled = atom<boolean>(false);

  /**
   * Whether transforming is enabled. Transforming is enabled only in 'all' interaction mode.
   */
  $isTransformEnabled = atom<boolean>(false);

  /**
   * Whether the transformer is currently processing (rasterizing and uploading) the transformed entity.
   */
  $isProcessing = atom(false);

  /**
   * Whether the transformer is currently in silent mode. In silent mode, the transform operation should not show any
   * visual feedback.
   *
   * This is set every time a transform is started.
   *
   * This is used for transform operations like directly fitting the entity to the bbox, which should not show the
   * transform controls, Transform react component or have any other visual feedback. The transform should just happen
   * silently.
   */
  $silentTransform = atom(false);

  /**
   * A mutex to prevent concurrent operations.
   *
   * The mutex is locked during transformation and during rect calculations which are handled in a web worker.
   */
  transformMutex = new Mutex();

  /**
   * Callbacks that are executed when the bbox is updated.
   */
  private static bboxUpdatedCallbacks = new Set<LifecycleCallback>();

  konva: {
    transformer: Konva.Transformer;
    proxyRect: Konva.Rect;
    outlineRect: Konva.Rect;
    warpGroup: Konva.Group;
    warpPreview: Konva.Image;
    warpOutline: Konva.Line;
    warpDragArea: Konva.Line;
    warpAnchors: Record<keyof WarpCorners, Konva.Rect>;
    warpSideAnchors: Record<WarpSide, Konva.Rect>;
  };

  warpSourceCanvas: HTMLCanvasElement | null = null;
  warpSourceRect: Rect | null = null;
  warpCorners: WarpCorners | null = null;
  warpDragStartPointer: Coordinate | null = null;
  warpDragStartCorners: WarpCorners | null = null;
  warpSideDragStartPointer: Coordinate | null = null;
  warpSideDragStartCorners: WarpCorners | null = null;
  warpSideDragKey: WarpSide | null = null;
  affineSnapshot:
    | {
        proxyRect: {
          x: number;
          y: number;
          width: number;
          height: number;
          scaleX: number;
          scaleY: number;
          rotation: number;
        };
        objectGroup: {
          x: number;
          y: number;
          scaleX: number;
          scaleY: number;
          rotation: number;
        };
      }
    | null = null;
  constructor(parent: CanvasEntityTransformer['parent']) {
    super();
    this.id = getPrefixedId(this.type);
    this.parent = parent;
    this.manager = parent.manager;
    this.path = this.manager.buildPath(this);
    this.log = this.manager.buildLogger(this);

    this.log.debug('Creating module');

    const warpAnchorSize = this.config.SCALE_ANCHOR_SIZE;
    const makeWarpAnchor = (key: keyof WarpCorners) =>
      new Konva.Rect({
        name: `${this.type}:warp_anchor:${key}`,
        width: warpAnchorSize,
        height: warpAnchorSize,
        cornerRadius: warpAnchorSize * this.config.SCALE_ANCHOR_CORNER_RADIUS_RATIO,
        offsetX: warpAnchorSize / 2,
        offsetY: warpAnchorSize / 2,
        fill: this.config.SCALE_ANCHOR_FILL_COLOR,
        stroke: this.config.SCALE_ANCHOR_STROKE_COLOR,
        strokeWidth: this.config.SCALE_ANCHOR_STROKE_WIDTH,
        draggable: true,
        listening: false,
      });
    const makeWarpSideAnchor = (key: WarpSide) =>
      new Konva.Rect({
        name: `${this.type}:warp_side_anchor:${key}`,
        width: warpAnchorSize,
        height: warpAnchorSize,
        cornerRadius: warpAnchorSize * this.config.SCALE_ANCHOR_CORNER_RADIUS_RATIO,
        offsetX: warpAnchorSize / 2,
        offsetY: warpAnchorSize / 2,
        fill: this.config.SCALE_ANCHOR_FILL_COLOR,
        stroke: this.config.SCALE_ANCHOR_STROKE_COLOR,
        strokeWidth: this.config.SCALE_ANCHOR_STROKE_WIDTH,
        draggable: true,
        listening: false,
      });

    const emptyPreviewCanvas = document.createElement('canvas');
    emptyPreviewCanvas.width = 1;
    emptyPreviewCanvas.height = 1;

    this.konva = {
      outlineRect: new Konva.Rect({
        listening: false,
        draggable: false,
        name: `${this.type}:outline_rect`,
        stroke: this.config.OUTLINE_COLOR,
        perfectDrawEnabled: false,
        hitStrokeWidth: 0,
      }),
      transformer: new Konva.Transformer({
        name: `${this.type}:transformer`,
        // Visibility and listening are managed via activate() and deactivate()
        visible: false,
        listening: false,
        // Rotation is allowed
        rotateEnabled: true,
        // When dragging a transform anchor across either the x or y axis, the nodes will be flipped across the axis
        flipEnabled: true,
        // Transforming will allow free aspect ratio only when shift is held
        keepRatio: true,
        shiftBehavior: 'inverted',
        // The padding is the distance between the transformer bbox and the nodes
        padding: this.config.OUTLINE_PADDING,
        // This is `invokeBlue.400`
        stroke: this.config.OUTLINE_COLOR,
        anchorFill: this.config.SCALE_ANCHOR_FILL_COLOR,
        anchorStroke: this.config.SCALE_ANCHOR_STROKE_COLOR,
        anchorStrokeWidth: this.config.SCALE_ANCHOR_STROKE_WIDTH,
        anchorSize: this.config.SCALE_ANCHOR_SIZE,
        anchorCornerRadius: this.config.SCALE_ANCHOR_SIZE * this.config.SCALE_ANCHOR_CORNER_RADIUS_RATIO,
        // This function is called for each anchor to style it (and do anything else you might want to do).
        anchorStyleFunc: this.anchorStyleFunc,
        anchorDragBoundFunc: this.anchorDragBoundFunc,
        boundBoxFunc: this.boxBoundFunc,
      }),
      proxyRect: new Konva.Rect({
        name: `${this.type}:proxy_rect`,
        listening: false,
        draggable: true,
      }),
      warpGroup: new Konva.Group({
        name: `${this.type}:warp_group`,
        visible: false,
        listening: false,
      }),
      warpPreview: new Konva.Image({
        name: `${this.type}:warp_preview`,
        listening: false,
        image: emptyPreviewCanvas,
        perfectDrawEnabled: false,
      }),
      warpOutline: new Konva.Line({
        name: `${this.type}:warp_outline`,
        listening: false,
        closed: true,
        stroke: this.config.OUTLINE_COLOR,
        strokeWidth: 1,
        perfectDrawEnabled: false,
      }),
      warpDragArea: new Konva.Line({
        name: `${this.type}:warp_drag_area`,
        listening: false,
        draggable: true,
        closed: true,
        strokeEnabled: false,
        fillEnabled: true,
        fill: 'rgba(0,0,0,0)',
      }),
      warpAnchors: {
        tl: makeWarpAnchor('tl'),
        tr: makeWarpAnchor('tr'),
        br: makeWarpAnchor('br'),
        bl: makeWarpAnchor('bl'),
      },
      warpSideAnchors: {
        tm: makeWarpSideAnchor('tm'),
        mr: makeWarpSideAnchor('mr'),
        bm: makeWarpSideAnchor('bm'),
        ml: makeWarpSideAnchor('ml'),
      },
    };

    this.konva.transformer.on('transform', this.syncObjectGroupWithProxyRect);
    this.konva.transformer.on('transformend', this.snapProxyRectToPixelGrid);
    this.konva.transformer.on('pointerenter', () => {
      this.manager.stage.setCursor('move');
    });
    this.konva.transformer.on('pointerleave', () => {
      this.manager.stage.setCursor('default');
    });
    this.konva.proxyRect.on('dragmove', this.onDragMove);
    this.konva.proxyRect.on('dragend', this.onDragEnd);
    this.konva.proxyRect.on('pointerenter', () => {
      this.manager.stage.setCursor('move');
    });
    this.konva.proxyRect.on('pointerleave', () => {
      this.manager.stage.setCursor('default');
    });

    this.konva.warpDragArea.dragBoundFunc(() => ({ x: 0, y: 0 }));
    this.konva.warpDragArea.on('dragstart', this.onWarpDragStart);
    this.konva.warpDragArea.on('dragmove', this.onWarpDragMove);
    this.konva.warpDragArea.on('dragend', this.onWarpDragEnd);

    for (const anchor of Object.values(this.konva.warpAnchors)) {
      anchor.on('dragstart', () => undefined);
      anchor.on('dragmove', this.onWarpAnchorDragMove);
      anchor.on('dragend', this.onWarpAnchorDragEnd);
      anchor.on('pointerenter', () => {
        this.manager.stage.setCursor('move');
      });
      anchor.on('pointerleave', () => {
        this.manager.stage.setCursor('default');
      });
    }
    for (const anchor of Object.values(this.konva.warpSideAnchors)) {
      anchor.on('dragstart', this.onWarpSideDragStart);
      anchor.on('dragmove', this.onWarpSideDragMove);
      anchor.on('dragend', this.onWarpSideDragEnd);
      anchor.on('pointerenter', () => {
        this.manager.stage.setCursor('move');
      });
      anchor.on('pointerleave', () => {
        this.manager.stage.setCursor('default');
      });
    }

    this.subscriptions.add(() => {
      this.konva.transformer.off('transform transformend pointerenter pointerleave');
      this.konva.proxyRect.off('dragmove dragend pointerenter pointerleave');
      this.konva.warpDragArea.off('dragstart dragmove dragend');
      for (const anchor of Object.values(this.konva.warpAnchors)) {
        anchor.off('dragstart dragmove dragend pointerenter pointerleave');
      }
      for (const anchor of Object.values(this.konva.warpSideAnchors)) {
        anchor.off('dragstart dragmove dragend pointerenter pointerleave');
      }
    });

    // When the stage scale changes, we may need to re-scale some of the transformer's components. For example,
    // the bbox outline should always be 1 screen pixel wide, so we need to update its stroke width.
    this.subscriptions.add(
      this.manager.stage.$stageAttrs.listen((newVal, oldVal) => {
        if (areStageAttrsGonnaExplode(newVal)) {
          return;
        }
        if (newVal.scale !== oldVal.scale) {
          this.syncScale();
        }
      })
    );

    // While the user holds shift, we want to snap rotation to 45 degree increments. Listen for the shift key state
    // and update the snap angles accordingly.
    this.subscriptions.add(
      this.manager.stateApi.$shiftKey.listen((newVal) => {
        this.konva.transformer.rotationSnaps(newVal ? [0, 45, 90, 135, 180, 225, 270, 315] : []);
      })
    );

    // When the selected tool changes, we need to update the transformer's interaction state.
    this.subscriptions.add(this.manager.tool.$tool.listen(this.syncInteractionState));

    // When the selected entity changes, we need to update the transformer's interaction state.
    this.subscriptions.add(
      this.manager.stateApi.createStoreSubscription(selectSelectedEntityIdentifier, this.syncInteractionState)
    );

    /**
     * When the canvas global state changes, we need to update the transformer's interaction state. This implies
     * a change to staging or some other global state that affects the transformer.
     */
    this.subscriptions.add(this.manager.$isBusy.listen(this.syncInteractionState));

    this.konva.warpGroup.add(this.konva.warpPreview);
    this.konva.warpGroup.add(this.konva.warpOutline);
    this.konva.warpGroup.add(this.konva.warpDragArea);
    for (const anchor of Object.values(this.konva.warpAnchors)) {
      this.konva.warpGroup.add(anchor);
    }
    for (const anchor of Object.values(this.konva.warpSideAnchors)) {
      this.konva.warpGroup.add(anchor);
    }

    this.parent.konva.layer.add(this.konva.outlineRect);
    this.parent.konva.layer.add(this.konva.proxyRect);
    this.parent.konva.layer.add(this.konva.transformer);
    this.parent.konva.layer.add(this.konva.warpGroup);
  }

  initialize = () => {
    this.log.debug('Initializing module');
    this.syncInteractionState();
  };

  syncCursorStyle = () => {
    if (!this.parent.renderer.hasObjects()) {
      this.manager.stage.setCursor('not-allowed');
    } else {
      this.manager.stage.setCursor('default');
    }
  };

  anchorStyleFunc = (anchor: Konva.Rect): void => {
    // Give the rotater special styling
    if (anchor.hasName('rotater')) {
      anchor.setAttrs({
        height: this.config.ROTATE_ANCHOR_SIZE,
        width: this.config.ROTATE_ANCHOR_SIZE,
        cornerRadius: this.config.ROTATE_ANCHOR_SIZE * this.config.SCALE_ANCHOR_CORNER_RADIUS_RATIO,
        fill: this.config.ROTATE_ANCHOR_FILL_COLOR,
        stroke: this.config.SCALE_ANCHOR_FILL_COLOR,
        offsetX: this.config.ROTATE_ANCHOR_SIZE / 2,
        offsetY: this.config.ROTATE_ANCHOR_SIZE / 2,
      });
    }
    // Add some padding to the hit area of the anchors
    anchor.hitFunc((context) => {
      context.beginPath();
      context.rect(
        -this.config.ANCHOR_HIT_PADDING,
        -this.config.ANCHOR_HIT_PADDING,
        anchor.width() + this.config.ANCHOR_HIT_PADDING * 2,
        anchor.height() + this.config.ANCHOR_HIT_PADDING * 2
      );
      context.closePath();
      context.fillStrokeShape(anchor);
    });
  };

  setTransformMode = (mode: TransformMode) => {
    const current = this.$transformMode.get();
    if (current === mode) {
      return;
    }
    this.$transformMode.set(mode);
    if (this.$isTransforming.get()) {
      if (mode === 'warp') {
        this.affineSnapshot = {
          proxyRect: {
            x: this.konva.proxyRect.x(),
            y: this.konva.proxyRect.y(),
            width: this.konva.proxyRect.width(),
            height: this.konva.proxyRect.height(),
            scaleX: this.konva.proxyRect.scaleX(),
            scaleY: this.konva.proxyRect.scaleY(),
            rotation: this.konva.proxyRect.rotation(),
          },
          objectGroup: {
            x: this.parent.renderer.konva.objectGroup.x(),
            y: this.parent.renderer.konva.objectGroup.y(),
            scaleX: this.parent.renderer.konva.objectGroup.scaleX(),
            scaleY: this.parent.renderer.konva.objectGroup.scaleY(),
            rotation: this.parent.renderer.konva.objectGroup.rotation(),
          },
        };
        this.prepareWarpPreview();
      } else if (current === 'warp') {
        this.teardownWarpPreview();
        if (this.affineSnapshot) {
          const { proxyRect, objectGroup } = this.affineSnapshot;
          this.parent.renderer.konva.objectGroup.setAttrs(objectGroup);
          this.konva.proxyRect.setAttrs(proxyRect);
          this.syncScale();
          this.konva.transformer.forceUpdate();
        }
        this.affineSnapshot = null;
      }
    }
    this.syncInteractionState();
  };

  onWarpAnchorDragMove = (e: Konva.KonvaEventObject<DragEvent>) => {
    if (!this.warpCorners || !this.warpSourceRect) {
      return;
    }
    const anchorNode = e.target as Konva.Rect;
    const nameParts = anchorNode.name().split(':');
    const key = nameParts.at(-1) as keyof WarpCorners | undefined;
    if (!key || !(key in this.warpCorners)) {
      return;
    }
    const absPos = anchorNode.getAbsolutePosition();
    const snappedAbs = this.snapWarpAnchor(absPos);
    const snapped = this.toLayerPoint(snappedAbs);
    this.warpCorners = { ...this.warpCorners, [key]: snapped };
    anchorNode.position(snapped);
    this.updateWarpBBoxFromCorners();
    this.updateWarpNodes();
  };

  onWarpAnchorDragEnd = () => undefined;

  getStagePointer = (): Coordinate | null => {
    const stage = (this.manager.stage as { konva?: { stage?: Konva.Stage } }).konva?.stage;
    const p = stage?.getPointerPosition?.();
    return p ? { x: p.x, y: p.y } : null;
  };

  onWarpDragStart = () => {
    if (!this.warpCorners) {
      return;
    }
    const p = this.getStagePointer();
    if (!p) {
      return;
    }

    this.warpDragStartPointer = p;
    this.warpDragStartCorners = {
      tl: { ...this.warpCorners.tl },
      tr: { ...this.warpCorners.tr },
      br: { ...this.warpCorners.br },
      bl: { ...this.warpCorners.bl },
    };
  };

  onWarpDragMove = () => {
    if (!this.warpDragStartPointer || !this.warpDragStartCorners) {
      return;
    }
    const p = this.getStagePointer();
    if (!p) {
      return;
    }

    const dx = p.x - this.warpDragStartPointer.x;
    const dy = p.y - this.warpDragStartPointer.y;

    const s = this.warpDragStartCorners;
    this.warpCorners = {
      tl: { x: s.tl.x + dx, y: s.tl.y + dy },
      tr: { x: s.tr.x + dx, y: s.tr.y + dy },
      br: { x: s.br.x + dx, y: s.br.y + dy },
      bl: { x: s.bl.x + dx, y: s.bl.y + dy },
    };

    this.updateWarpBBoxFromCorners();
    this.updateWarpNodes();
  };

  onWarpDragEnd = () => {
    this.warpDragStartPointer = null;
    this.warpDragStartCorners = null;
  };

  onWarpSideDragStart = (e: Konva.KonvaEventObject<DragEvent>) => {
    if (!this.warpCorners) {
      return;
    }
    const anchorNode = e.target as Konva.Rect;
    const nameParts = anchorNode.name().split(':');
    const key = nameParts.at(-1) as WarpSide | undefined;
    if (!key) {
      return;
    }
    const p = this.getStagePointer();
    if (!p) {
      return;
    }
    this.warpSideDragKey = key;
    this.warpSideDragStartPointer = p;
    this.warpSideDragStartCorners = {
      tl: { ...this.warpCorners.tl },
      tr: { ...this.warpCorners.tr },
      br: { ...this.warpCorners.br },
      bl: { ...this.warpCorners.bl },
    };
  };

  onWarpSideDragMove = () => {
    if (!this.warpSideDragKey || !this.warpSideDragStartPointer || !this.warpSideDragStartCorners) {
      return;
    }
    const p = this.getStagePointer();
    if (!p) {
      return;
    }
    const dx = p.x - this.warpSideDragStartPointer.x;
    const dy = p.y - this.warpSideDragStartPointer.y;
    const s = this.warpSideDragStartCorners;
    let next: WarpCorners = { ...s };
    if (this.warpSideDragKey === 'tm') {
      next = {
        ...s,
        tl: { x: s.tl.x + dx, y: s.tl.y + dy },
        tr: { x: s.tr.x + dx, y: s.tr.y + dy },
      };
    } else if (this.warpSideDragKey === 'mr') {
      next = {
        ...s,
        tr: { x: s.tr.x + dx, y: s.tr.y + dy },
        br: { x: s.br.x + dx, y: s.br.y + dy },
      };
    } else if (this.warpSideDragKey === 'bm') {
      next = {
        ...s,
        br: { x: s.br.x + dx, y: s.br.y + dy },
        bl: { x: s.bl.x + dx, y: s.bl.y + dy },
      };
    } else if (this.warpSideDragKey === 'ml') {
      next = {
        ...s,
        tl: { x: s.tl.x + dx, y: s.tl.y + dy },
        bl: { x: s.bl.x + dx, y: s.bl.y + dy },
      };
    }
    this.warpCorners = next;
    this.updateWarpBBoxFromCorners();
    this.updateWarpNodes();
  };

  onWarpSideDragEnd = () => {
    this.warpSideDragKey = null;
    this.warpSideDragStartPointer = null;
    this.warpSideDragStartCorners = null;
  };

  toLayerPoint = (pos: Coordinate): Coordinate => {
    const transform = this.parent.konva.layer.getAbsoluteTransform().copy();
    transform.invert();
    return transform.point(pos);
  };



  snapWarpAnchor = (pos: Coordinate): Coordinate => {
    const gridSize = this.manager.stateApi.getPositionGridSize();
    if (gridSize <= 1) {
      return pos;
    }
    const stageScale = this.manager.stage.getScale();
    const stagePos = this.manager.stage.getPosition();
    const targetX = roundToMultiple(pos.x / stageScale, gridSize);
    const targetY = roundToMultiple(pos.y / stageScale, gridSize);
    const scaledOffsetX = stagePos.x % (stageScale * gridSize);
    const scaledOffsetY = stagePos.y % (stageScale * gridSize);
    return {
      x: targetX * stageScale + scaledOffsetX,
      y: targetY * stageScale + scaledOffsetY,
    };
  };

  updateWarpNodes = () => {
    if (!this.warpCorners) {
      return;
    }
    const { tl, tr, br, bl } = this.warpCorners;
    const points = [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y];
    this.konva.warpOutline.points(points);
    this.konva.warpDragArea.points(points);
    this.konva.warpAnchors.tl.position(tl);
    this.konva.warpAnchors.tr.position(tr);
    this.konva.warpAnchors.br.position(br);
    this.konva.warpAnchors.bl.position(bl);
    this.konva.warpSideAnchors.tm.position({ x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 });
    this.konva.warpSideAnchors.mr.position({ x: (tr.x + br.x) / 2, y: (tr.y + br.y) / 2 });
    this.konva.warpSideAnchors.bm.position({ x: (br.x + bl.x) / 2, y: (br.y + bl.y) / 2 });
    this.konva.warpSideAnchors.ml.position({ x: (bl.x + tl.x) / 2, y: (bl.y + tl.y) / 2 });
    this.updateWarpPreviewImage();
    this.konva.warpPreview.getLayer()?.batchDraw();
    this.konva.warpPreview.draw();
  };

  updateWarpPreviewImage = () => {
    if (!this.warpSourceCanvas || !this.warpCorners) {
      return;
    }
    const warped = this.getWarpedCanvas({ quality: 'preview' });
    this.konva.warpPreview.setAttrs({
      x: warped.rect.x,
      y: warped.rect.y,
      width: Math.max(1, warped.rect.width),
      height: Math.max(1, warped.rect.height),
    });
    this.konva.warpPreview.image(warped.canvas);
  };

  computeHomography = (src: Coordinate[], dst: Coordinate[]): number[] => {
    if (src.length !== dst.length || src.length < 4) {
      return new Array(8).fill(0);
    }
    const A: number[][] = [];
    const b: number[] = [];
    for (let i = 0; i < src.length; i++) {
      const s = src[i];
      const d = dst[i];
      if (!s || !d) {
        return new Array(8).fill(0);
      }
      const { x, y } = s;
      const { x: u, y: v } = d;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      b.push(v);
    }
    return this.solveLinearSystem(A, b);
  };

  solveLinearSystem = (A: number[][], b: number[]): number[] => {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < n; col++) {
      let pivotRow = col;
      let maxVal = Math.abs(M[col]?.[col] ?? 0);
      for (let row = col + 1; row < n; row++) {
        const val = Math.abs(M[row]?.[col] ?? 0);
        if (val > maxVal) {
          maxVal = val;
          pivotRow = row;
        }
      }
      if (maxVal === 0) {
        return new Array(n).fill(0);
      }
      if (pivotRow !== col) {
        const tmp = M[col]!;
        M[col] = M[pivotRow]!;
        M[pivotRow] = tmp;
      }
      const colData = M[col];
      if (!colData) {
        return new Array(n).fill(0);
      }
      const pivot = colData[col] ?? 0;
      for (let c = col; c <= n; c++) {
        const value = colData[c] ?? 0;
        colData[c] = value / pivot;
      }
      for (let row = 0; row < n; row++) {
        if (row === col) {
          continue;
        }
        const rowData = M[row];
        if (!rowData) {
          continue;
        }
        const factor = rowData[col] ?? 0;
        for (let c = col; c <= n; c++) {
          const rowValue = rowData[c] ?? 0;
          const colValue = colData[c] ?? 0;
          rowData[c] = rowValue - factor * colValue;
        }
      }
    }

    return M.map((row) => row?.[n] ?? 0);
  };

  applyHomography = (h: number[], p: Coordinate): Coordinate => {
    const [h11 = 0, h12 = 0, h13 = 0, h21 = 0, h22 = 0, h23 = 0, h31 = 0, h32 = 0] = h;
    const denom = h31 * p.x + h32 * p.y + 1;
    if (denom === 0) {
      return { x: 0, y: 0 };
    }
    return {
      x: (h11 * p.x + h12 * p.y + h13) / denom,
      y: (h21 * p.x + h22 * p.y + h23) / denom,
    };
  };

  isValidHomography = (h: number[]): boolean => {
    return h.length === 8 && h.every((value) => Number.isFinite(value));
  };

  getWarpSegments = (width: number, height: number, quality: 'preview' | 'final'): number => {
    const targetSize = quality === 'preview' ? 128 : 64;
    const maxDim = Math.max(width, height);
    return Math.max(4, Math.ceil(maxDim / targetSize));
  };

  updateWarpBBoxFromCorners = () => {
    if (!this.warpCorners) {
      return;
    }
    const { tl, tr, br, bl } = this.warpCorners;
    const minX = Math.min(tl.x, tr.x, br.x, bl.x);
    const maxX = Math.max(tl.x, tr.x, br.x, bl.x);
    const minY = Math.min(tl.y, tr.y, br.y, bl.y);
    const maxY = Math.max(tl.y, tr.y, br.y, bl.y);
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);

    const onePixel = this.manager.stage.unscale(1);
    const bboxPadding = this.manager.stage.unscale(this.config.OUTLINE_PADDING);

    this.konva.proxyRect.setAttrs({
      x: minX,
      y: minY,
      width,
      height,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
    });
    this.konva.outlineRect.setAttrs({
      x: minX - bboxPadding,
      y: minY - bboxPadding,
      width: width + bboxPadding * 2,
      height: height + bboxPadding * 2,
      strokeWidth: onePixel,
    });
  };

  resetProxyRectToPixelRect = () => {
    const pixelRect = this.$pixelRect.get();
    this.update(this.parent.state.position, pixelRect);
  };

  drawWarpTriangle = (
    context: Konva.Context | CanvasRenderingContext2D,
    image: HTMLCanvasElement,
    srcTri: [Coordinate, Coordinate, Coordinate],
    dstTri: [Coordinate, Coordinate, Coordinate]
  ) => {
    const [s0, s1, s2] = srcTri;
    const [d0, d1, d2] = dstTri;
    const denom = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
    if (denom === 0) {
      return;
    }
    const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denom;
    const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denom;
    const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denom;
    const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denom;
    const e =
      (d0.x * (s1.x * s2.y - s2.x * s1.y) +
        d1.x * (s2.x * s0.y - s0.x * s2.y) +
        d2.x * (s0.x * s1.y - s1.x * s0.y)) /
      denom;
    const f =
      (d0.y * (s1.x * s2.y - s2.x * s1.y) +
        d1.y * (s2.x * s0.y - s0.x * s2.y) +
        d2.y * (s0.x * s1.y - s1.x * s0.y)) /
      denom;

    const centroid = { x: (d0.x + d1.x + d2.x) / 3, y: (d0.y + d1.y + d2.y) / 3 };
    const expand = (p: Coordinate, pad: number): Coordinate => {
      const vx = p.x - centroid.x;
      const vy = p.y - centroid.y;
      const len = Math.hypot(vx, vy);
      if (len === 0) {
        return p;
      }
      const scale = (len + pad) / len;
      return { x: centroid.x + vx * scale, y: centroid.y + vy * scale };
    };
    const pad = 0.75;
    const c0 = expand(d0, pad);
    const c1 = expand(d1, pad);
    const c2 = expand(d2, pad);

    context.save();
    context.beginPath();
    context.moveTo(c0.x, c0.y);
    context.lineTo(c1.x, c1.y);
    context.lineTo(c2.x, c2.y);
    context.closePath();
    context.clip();
    context.setTransform(a, b, c, d, e, f);
    context.drawImage(image, 0, 0);
    context.restore();
  };

  anchorDragBoundFunc = (oldPos: Coordinate, newPos: Coordinate) => {
    // The anchorDragBoundFunc callback puts constraints on the movement of the transformer anchors, which in
    // turn constrain the transformation. It is called on every anchor move. We'll use this to snap the anchors
    // to the nearest pixel.

    // If we are rotating, no need to do anything - just let the rotation happen.
    if (this.konva.transformer.getActiveAnchor() === 'rotater') {
      return newPos;
    }

    // If the user is not holding shift, the transform is retaining aspect ratio. It's not possible to snap to the grid
    // in this case, because that would change the aspect ratio. So, we only snap to the grid when shift is held.
    const gridSize = this.manager.stateApi.$shiftKey.get() ? this.manager.stateApi.getPositionGridSize() : 1;

    // We need to snap the anchor to the selected grid size, but the positions provided to this callback are absolute,
    // scaled coordinates. They need to be converted to stage coordinates, snapped, then converted back to absolute
    // before returning them.
    const stageScale = this.manager.stage.getScale();
    const stagePos = this.manager.stage.getPosition();

    // Unscale and snap the coordinate.
    const targetX = roundToMultiple(newPos.x / stageScale, gridSize);
    const targetY = roundToMultiple(newPos.y / stageScale, gridSize);

    // The stage may be offset by fraction of the grid snap size. To ensure the anchor snaps to the grid, we need to
    // calculate that offset and add it back to the target position.

    // Calculate the offset. It's the remainder of the stage position divided by the scale * grid snap value in pixels.
    const scaledOffsetX = stagePos.x % (stageScale * gridSize);
    const scaledOffsetY = stagePos.y % (stageScale * gridSize);

    // Unscale the target position and add the offset to get the absolute position for this anchor.
    const scaledTargetX = targetX * stageScale + scaledOffsetX;
    const scaledTargetY = targetY * stageScale + scaledOffsetY;

    return { x: scaledTargetX, y: scaledTargetY };
  };

  boxBoundFunc = (oldBoundBox: RectWithRotation, newBoundBox: RectWithRotation) => {
    // Bail if we are not rotating, we don't need to do anything.
    if (this.konva.transformer.getActiveAnchor() !== 'rotater') {
      return newBoundBox;
    }

    // This transform constraint operates on the bounding box of the transformer. This box has x, y, width, and
    // height in stage coordinates, and rotation in radians. This can be used to snap the transformer rotation to
    // the nearest 45 degrees when shift is held.
    if (this.manager.stateApi.$shiftKey.get()) {
      if (Math.abs(newBoundBox.rotation % (Math.PI / 4)) > 0) {
        return oldBoundBox;
      }
    }

    return newBoundBox;
  };

  /**
   * Snaps the proxy rect to the nearest pixel, syncing the object group with the proxy rect.
   */
  snapProxyRectToPixelGrid = () => {
    // Called on mouse up on an anchor. We'll do some final snapping to ensure the transformer is pixel-perfect.

    // Snap the position to the nearest pixel.
    const x = this.konva.proxyRect.x();
    const y = this.konva.proxyRect.y();
    const snappedX = Math.round(x);
    const snappedY = Math.round(y);

    // The transformer doesn't modify the width and height. It only modifies scale. We'll need to apply the scale to
    // the width and height, round them to the nearest pixel, and finally calculate a new scale that will result in
    // the snapped width and height.
    const width = this.konva.proxyRect.width();
    const height = this.konva.proxyRect.height();
    const scaleX = this.konva.proxyRect.scaleX();
    const scaleY = this.konva.proxyRect.scaleY();

    // Determine the target width and height, rounded to the nearest pixel. Must be >= 1. Because the scales can be
    // negative, we need to take the absolute value of the width and height.
    const targetWidth = Math.max(Math.abs(Math.round(width * scaleX)), 1);
    const targetHeight = Math.max(Math.abs(Math.round(height * scaleY)), 1);

    // Calculate the scale we need to use to get the target width and height. Restore the sign of the scales.
    const snappedScaleX = (targetWidth / width) * Math.sign(scaleX);
    const snappedScaleY = (targetHeight / height) * Math.sign(scaleY);

    // Update interaction rect and object group attributes.
    this.konva.proxyRect.setAttrs({
      x: snappedX,
      y: snappedY,
      scaleX: snappedScaleX,
      scaleY: snappedScaleY,
    });

    this.syncObjectGroupWithProxyRect();
  };

  /**
   * Fits the entity to the bbox using the "fill" strategy.
   */
  fitToBboxFill = () => {
    if (!this.$isTransformEnabled.get()) {
      this.log.warn(
        'Cannot fit to bbox contain when transform is disabled. Did you forget to call `await adapter.transformer.startTransform()`?'
      );
      return;
    }
    const { rect } = this.manager.stateApi.getBbox();
    const scaleX = rect.width / this.konva.proxyRect.width();
    const scaleY = rect.height / this.konva.proxyRect.height();
    this.konva.proxyRect.setAttrs({
      x: rect.x,
      y: rect.y,
      scaleX,
      scaleY,
      rotation: 0,
    });
    this.syncObjectGroupWithProxyRect();
  };

  /**
   * Fits the entity to the bbox using the "contain" strategy.
   */
  fitToBboxContain = () => {
    if (!this.$isTransformEnabled.get()) {
      this.log.warn(
        'Cannot fit to bbox contain when transform is disabled. Did you forget to call `await adapter.transformer.startTransform()`?'
      );
      return;
    }
    const { rect } = this.manager.stateApi.getBbox();
    const gridSize = this.manager.stateApi.getPositionGridSize();
    const width = this.konva.proxyRect.width();
    const height = this.konva.proxyRect.height();
    const scaleX = rect.width / width;
    const scaleY = rect.height / height;

    // "contain" means that the entity should be scaled to fit within the bbox, but it should not exceed the bbox.
    const scale = Math.min(scaleX, scaleY);

    // Calculate the scaled dimensions
    const scaledWidth = width * scale;
    const scaledHeight = height * scale;

    // Calculate centered position
    const centerX = rect.x + (rect.width - scaledWidth) / 2;
    const centerY = rect.y + (rect.height - scaledHeight) / 2;

    // Round to grid and clamp to valid bounds
    const roundedX = gridSize > 1 ? roundToMultiple(centerX, gridSize) : centerX;
    const roundedY = gridSize > 1 ? roundToMultiple(centerY, gridSize) : centerY;

    const x = clamp(roundedX, rect.x, rect.x + rect.width - scaledWidth);
    const y = clamp(roundedY, rect.y, rect.y + rect.height - scaledHeight);

    this.konva.proxyRect.setAttrs({
      x,
      y,
      scaleX: scale,
      scaleY: scale,
      rotation: 0,
    });
    this.syncObjectGroupWithProxyRect();
  };

  /**
   * Fits the entity to the bbox using the "cover" strategy.
   */
  fitToBboxCover = () => {
    if (!this.$isTransformEnabled.get()) {
      this.log.warn(
        'Cannot fit to bbox contain when transform is disabled. Did you forget to call `await adapter.transformer.startTransform()`?'
      );
      return;
    }
    const { rect } = this.manager.stateApi.getBbox();
    const gridSize = this.manager.stateApi.getPositionGridSize();
    const width = this.konva.proxyRect.width();
    const height = this.konva.proxyRect.height();
    const scaleX = rect.width / width;
    const scaleY = rect.height / height;

    // "cover" means the entity should cover the entire bbox, potentially overflowing
    const scale = Math.max(scaleX, scaleY);

    // Calculate the scaled dimensions
    const scaledWidth = width * scale;
    const scaledHeight = height * scale;

    // Calculate position - center only if entity exceeds bbox
    let x = rect.x;
    let y = rect.y;

    // If scaled width exceeds bbox width, center horizontally
    if (scaledWidth > rect.width) {
      const centerX = rect.x + (rect.width - scaledWidth) / 2;
      x = gridSize > 1 ? roundToMultiple(centerX, gridSize) : centerX;
    }

    // If scaled height exceeds bbox height, center vertically
    if (scaledHeight > rect.height) {
      const centerY = rect.y + (rect.height - scaledHeight) / 2;
      y = gridSize > 1 ? roundToMultiple(centerY, gridSize) : centerY;
    }

    this.konva.proxyRect.setAttrs({
      x,
      y,
      scaleX: scale,
      scaleY: scale,
      rotation: 0,
    });
    this.syncObjectGroupWithProxyRect();
  };

  onDragMove = () => {
    // Snap the interaction rect to the grid
    const gridSize = this.manager.stateApi.getPositionGridSize();
    this.konva.proxyRect.x(roundToMultiple(this.konva.proxyRect.x(), gridSize));
    this.konva.proxyRect.y(roundToMultiple(this.konva.proxyRect.y(), gridSize));

    // The bbox should be updated to reflect the new position of the interaction rect, taking into account its padding
    // and border
    const padding = this.manager.stage.unscale(this.config.OUTLINE_PADDING);
    this.konva.outlineRect.setAttrs({
      x: this.konva.proxyRect.x() - padding,
      y: this.konva.proxyRect.y() - padding,
    });

    // The object group is translated by the difference between the interaction rect's new and old positions (which is
    // stored as this.pixelRect)
    this.parent.renderer.konva.objectGroup.setAttrs({
      x: this.konva.proxyRect.x(),
      y: this.konva.proxyRect.y(),
    });
  };

  onDragEnd = () => {
    if (this.$isTransforming.get()) {
      // If we are transforming the entity, we should not push the new position to the state. This will trigger a
      // re-render of the entity and bork the transformation.
      return;
    }

    const pixelRect = this.$pixelRect.get();

    const position = {
      x: this.konva.proxyRect.x() - pixelRect.x,
      y: this.konva.proxyRect.y() - pixelRect.y,
    };

    this.log.trace({ position }, 'Position changed');
    this.manager.stateApi.setEntityPosition({ entityIdentifier: this.parent.entityIdentifier, position });
  };

  nudgeBy = (offset: Coordinate) => {
    // We can immediately move both the proxy rect and layer objects so we don't have to wait for a redux round-trip,
    // which can take up to 2ms in my testing. This is optional, but can make the interaction feel more responsive,
    // especially on lower-end devices.
    // Get the relative position of the layer's objects, according to konva
    const position = this.konva.proxyRect.position();
    // Offset the position by the nudge amount
    const newPosition = offsetCoord(position, offset);
    // Set the new position of the proxy rect - this doesn't move the layer objects - only the outline rect
    this.konva.proxyRect.setAttrs(newPosition);
    // Sync the layer objects with the proxy rect - moves them to the new position
    this.syncObjectGroupWithProxyRect();

    // Push to redux. The state change will do a round-trip, and eventually make it back to the canvas classes, at
    // which point the layer will be moved to the new position.
    this.manager.stateApi.moveEntityBy({ entityIdentifier: this.parent.entityIdentifier, offset });
    this.log.trace({ offset }, 'Nudged');
  };

  syncObjectGroupWithProxyRect = () => {
    this.parent.renderer.konva.objectGroup.setAttrs({
      x: this.konva.proxyRect.x(),
      y: this.konva.proxyRect.y(),
      scaleX: this.konva.proxyRect.scaleX(),
      scaleY: this.konva.proxyRect.scaleY(),
      rotation: this.konva.proxyRect.rotation(),
    });
  };

  /**
   * Updates the transformer's visual components to match the parent entity's position and bounding box.
   * @param position The position of the parent entity
   * @param bbox The bounding box of the parent entity
   */
  update = (position: Coordinate, bbox: Rect) => {
    const onePixel = this.manager.stage.unscale(1);
    const bboxPadding = this.manager.stage.unscale(this.config.OUTLINE_PADDING);

    this.konva.outlineRect.setAttrs({
      x: position.x + bbox.x - bboxPadding,
      y: position.y + bbox.y - bboxPadding,
      width: bbox.width + bboxPadding * 2,
      height: bbox.height + bboxPadding * 2,
      strokeWidth: onePixel,
    });
    this.konva.proxyRect.setAttrs({
      x: position.x + bbox.x,
      y: position.y + bbox.y,
      width: bbox.width,
      height: bbox.height,
    });
  };

  /**
   * Syncs the transformer's interaction state with the application and entity's states. This is called when the entity
   * is selected or deselected, or when the user changes the selected tool.
   */
  syncInteractionState = () => {
    this.log.trace('Syncing interaction state');

    if (this.manager.stagingArea.$isStaging.get()) {
      // While staging, the layer should not be interactable
      this.parent.konva.layer.listening(false);
      this._setInteractionMode('off');
      return;
    }

    if (this.parent.segmentAnything?.$isSegmenting.get()) {
      // When segmenting, the layer should listen but the transformer should not be interactable
      this.parent.konva.layer.listening(true);
      this._setInteractionMode('off');
      return;
    }

    // Not all entities have a filterer - only raster layer and control layer adapters
    if (this.parent.filterer?.$isFiltering.get()) {
      // May not interact with the entity when the filter is active
      this.parent.konva.layer.listening(false);
      this._setInteractionMode('off');
      return;
    }

    if (this.manager.stateApi.$isTransforming.get() && !this.$isTransforming.get()) {
      // If another entity is being transformed, we can't interact with this transformer
      this.parent.konva.layer.listening(false);
      this._setInteractionMode('off');
      return;
    }

    const pixelRect = this.$pixelRect.get();
    const isPendingRectCalculation = this.$isPendingRectCalculation.get();

    if (isPendingRectCalculation || pixelRect.width === 0 || pixelRect.height === 0) {
      // If the rect is being calculated, or if the rect has no width or height, we can't interact with the transformer
      this.parent.konva.layer.listening(false);
      this._setInteractionMode('off');
      return;
    }

    const tool = this.manager.tool.$tool.get();
    const isSelected = this.manager.stateApi.getIsSelected(this.parent.id);

    if (!isSelected) {
      // The layer is not selected
      this.parent.konva.layer.listening(false);
      this._setInteractionMode('off');
      return;
    }

    if (this.parent.$isEmpty.get()) {
      // The layer is totally empty, we can just disable the layer
      this.parent.konva.layer.listening(false);
      this._setInteractionMode('off');
      return;
    }

    if (this.parent.$isLocked.get()) {
      // The layer is locked, it should not be interactable
      this.parent.konva.layer.listening(false);
      this._setInteractionMode('off');
      return;
    }

    if (!this.$isTransforming.get() && tool === 'move') {
      // We are moving this layer, it must be listening
      this.parent.konva.layer.listening(true);
      this._setInteractionMode('drag');
      return;
    }

    if (this.$isTransforming.get()) {
      // When transforming, we want the stage to still be movable if the view tool is selected. If the transformer is
      // active, it will interrupt the stage drag events. So we should disable listening when the view tool is selected.
      if (tool === 'view') {
        this.parent.konva.layer.listening(false);
        this._setInteractionMode('off');
      } else {
        this.parent.konva.layer.listening(true);
        this._setInteractionMode('all');
      }
      return;
    }

    // The layer is not selected
    this.parent.konva.layer.listening(false);
    this._setInteractionMode('off');
  };

  /**
   * Updates the transformer's scale. This is called when the stage is scaled.
   */
  syncScale = () => {
    const onePixel = this.manager.stage.unscale(1);
    const bboxPadding = this.manager.stage.unscale(this.config.OUTLINE_PADDING);

    this.konva.outlineRect.setAttrs({
      x: this.konva.proxyRect.x() - bboxPadding,
      y: this.konva.proxyRect.y() - bboxPadding,
      width: this.konva.proxyRect.width() * this.konva.proxyRect.scaleX() + bboxPadding * 2,
      height: this.konva.proxyRect.height() * this.konva.proxyRect.scaleY() + bboxPadding * 2,
      strokeWidth: onePixel,
    });
    this.konva.transformer.forceUpdate();
    this.syncWarpScale();
  };

  syncWarpScale = () => {
    const onePixel = this.manager.stage.unscale(1);
    const anchorSize = this.manager.stage.unscale(this.config.SCALE_ANCHOR_SIZE);
    this.konva.warpOutline.strokeWidth(onePixel);
    for (const anchor of Object.values(this.konva.warpAnchors)) {
      anchor.width(anchorSize);
      anchor.height(anchorSize);
      anchor.offsetX(anchorSize / 2);
      anchor.offsetY(anchorSize / 2);
    }
    for (const anchor of Object.values(this.konva.warpSideAnchors)) {
      anchor.width(anchorSize);
      anchor.height(anchorSize);
      anchor.offsetX(anchorSize / 2);
      anchor.offsetY(anchorSize / 2);
    }
  };

  /**
   * Starts the transformation of the entity.
   *
   * This method will asynchronously acquire a mutex to prevent concurrent operations. If you need to perform an
   * operation after the transformation is started, you should await this method.
   *
   * @param arg Options for starting the transformation
   * @param arg.silent Whether the transformation should be silent. If silent, the transform controls will not be shown,
   * so you _must_ call `applyTransform` or `stopTransform` to complete the transformation.
   *
   * @example
   * ```ts
   * await adapter.transformer.startTransform({ silent: true });
   * adapter.transformer.fitToBboxContain();
   * await adapter.transformer.applyTransform();
   * ```
   */
  startTransform = async (arg?: { silent: boolean }) => {
    const transformingAdapter = this.manager.stateApi.$transformingAdapter.get();
    if (transformingAdapter) {
      assert(false, `Already transforming an entity: ${transformingAdapter.id}`);
    }
    // This will be released when the transformation is stopped
    await this.transformMutex.acquire();
    this.log.debug('Starting transform');
    const { silent } = { silent: false, ...arg };
    this.$silentTransform.set(silent);
    this.$isTransforming.set(true);
    this.manager.stateApi.$transformingAdapter.set(this.parent);
    if (this.$transformMode.get() !== 'affine') {
      this.$transformMode.set('affine');
    }
    this.teardownWarpPreview();
    this.syncInteractionState();
  };

  /**
   * Applies the transformation of the entity.
   */
  applyTransform = async () => {
    if (!this.$isTransforming.get()) {
      this.log.warn(
        'Cannot apply transform when not transforming. Did you forget to call `await adapter.transformer.startTransform()`?'
      );
      return;
    }
    this.log.debug('Applying transform');
    this.$isProcessing.set(true);
    if (this.$transformMode.get() === 'warp') {
      this.$interactionMode.set('off');
      this._disableDrag();
      this._disableTransform();
      this.konva.warpGroup.listening(false);
      this.konva.warpDragArea.listening(false);
      for (const anchor of Object.values(this.konva.warpAnchors)) {
        anchor.listening(false);
      }
      for (const anchor of Object.values(this.konva.warpSideAnchors)) {
        anchor.listening(false);
      }
      const result = await withResultAsync(() => this.applyWarpTransform());
      if (result.isErr()) {
        toast({ status: 'error', title: 'Failed to apply transform' });
        this.log.error({ error: serializeError(result.error) }, 'Failed to apply warp transform');
      }
    } else {
      this._setInteractionMode('off');
      const rect = this.getRelativeRect();
      const rasterizeResult = await withResultAsync(() =>
        this.parent.renderer.rasterize({
          rect: roundRect(rect),
          replaceObjects: true,
          ignoreCache: true,
          attrs: { opacity: 1, filters: [] },
        })
      );
      if (rasterizeResult.isErr()) {
        toast({ status: 'error', title: 'Failed to apply transform' });
        this.log.error({ error: serializeError(rasterizeResult.error) }, 'Failed to rasterize entity');
      }
    }
    this.requestRectCalculation();
    this.stopTransform();
  };

  resetTransform = () => {
    this.resetScale();
    this.updatePosition();
    this.updateBbox();
  };

  /**
   * Stops the transformation of the entity. If the transformation is in progress, the entity will be reset to its
   * original state.
   */
  stopTransform = () => {
    this.log.debug('Stopping transform');

    this.$isTransforming.set(false);
    this.teardownWarpPreview();
    this.parent.renderer.showObjects();

    // Reset the transform of the the entity. We've either replaced the transformed objects with a rasterized image, or
    // canceled a transformation. In either case, the scale should be reset.
    this.resetTransform();
    this.syncInteractionState();
    this.manager.stateApi.$transformingAdapter.set(null);
    this.$isProcessing.set(false);
    this.transformMutex.release();
  };

  /**
   * Resets the scale of the transformer and the entity.
   * When the entity is transformed, it's scale and rotation are modified by the transformer. After canceling or applying
   * a transformation, the scale and rotation should be reset to the original values.
   */
  resetScale = () => {
    const attrs = {
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
    };
    this.parent.renderer.konva.objectGroup.setAttrs(attrs);
    this.parent.bufferRenderer.konva.group.setAttrs(attrs);
    this.konva.outlineRect.setAttrs(attrs);
    this.konva.proxyRect.setAttrs(attrs);
  };

  prepareWarpPreview = () => {
    if (!this.$isTransforming.get()) {
      return;
    }
    const rect = this.konva.proxyRect.getClientRect({ relativeTo: this.parent.konva.layer });
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    const canvas = this.parent.renderer.getCanvas({ rect: roundRect(rect), attrs: { opacity: 1, filters: [] } });
    const rotation = this.konva.proxyRect.rotation();
    if (rotation !== 0) {
      const unrotated = document.createElement('canvas');
      const targetWidth = Math.max(
        1,
        Math.round(Math.abs(this.konva.proxyRect.width() * this.konva.proxyRect.scaleX()))
      );
      const targetHeight = Math.max(
        1,
        Math.round(Math.abs(this.konva.proxyRect.height() * this.konva.proxyRect.scaleY()))
      );
      unrotated.width = targetWidth;
      unrotated.height = targetHeight;
      const ctx = unrotated.getContext('2d');
      if (!ctx) {
        return;
      }
      ctx.translate(unrotated.width / 2, unrotated.height / 2);
      ctx.rotate((-rotation * Math.PI) / 180);
      ctx.drawImage(canvas, -rect.width / 2, -rect.height / 2);
      this.warpSourceCanvas = unrotated;
    } else {
      this.warpSourceCanvas = canvas;
    }
    this.warpSourceRect = rect;
    this.warpCorners = this.getProxyRectCorners();
    this.konva.warpGroup.visible(true);
    this.konva.warpGroup.listening(true);
    this.konva.warpDragArea.listening(true);
    for (const anchor of Object.values(this.konva.warpAnchors)) {
      anchor.listening(true);
    }
    for (const anchor of Object.values(this.konva.warpSideAnchors)) {
      anchor.listening(true);
    }
    this.parent.renderer.hideObjects();
    this.syncWarpScale();
    this.updateWarpNodes();
  };

  getRelativePixelRect = (): Rect => {
    const pixelRect = this.$pixelRect.get();
    const position = this.parent.state.position;
    return {
      x: position.x + pixelRect.x,
      y: position.y + pixelRect.y,
      width: pixelRect.width,
      height: pixelRect.height,
    };
  };

  getProxyRectCorners = (): WarpCorners => {
    const transform = this.konva.proxyRect.getTransform();
    const width = this.konva.proxyRect.width();
    const height = this.konva.proxyRect.height();
    const tl = transform.point({ x: 0, y: 0 });
    const tr = transform.point({ x: width, y: 0 });
    const br = transform.point({ x: width, y: height });
    const bl = transform.point({ x: 0, y: height });
    return { tl, tr, br, bl };
  };

  teardownWarpPreview = () => {
    if (this.warpSourceCanvas) {
      this.warpSourceCanvas = null;
    }
    this.warpSourceRect = null;
    this.warpCorners = null;
    this.konva.warpGroup.visible(false);
    this.konva.warpGroup.listening(false);
    this.konva.warpDragArea.listening(false);
    for (const anchor of Object.values(this.konva.warpAnchors)) {
      anchor.listening(false);
    }
    for (const anchor of Object.values(this.konva.warpSideAnchors)) {
      anchor.listening(false);
    }
    this.parent.renderer.showObjects();
  };

  applyWarpTransform = async (): Promise<ImageDTO> => {
    assert(this.warpSourceCanvas && this.warpCorners, 'Missing warp source');
    this.updateWarpBBoxFromCorners();
    const warped = this.getWarpedCanvas({ quality: 'final' });
    const imageDTO = await this.parent.renderer.rasterizeCanvas({
      canvas: warped.canvas,
      rect: warped.rect,
      replaceObjects: true,
    });
    await this.manager.stateApi.waitForRasterizationToFinish();
    await this.parent.syncObjects();
    this.requestRectCalculation();
    return imageDTO;
  };

  getWarpedCanvas = (arg?: { quality?: 'preview' | 'final' }): { canvas: HTMLCanvasElement; rect: Rect } => {
    assert(this.warpSourceCanvas && this.warpCorners, 'Missing warp source');
    const quality: 'preview' | 'final' = arg?.quality ?? 'final';
    const { tl, tr, br, bl } = this.warpCorners;
    const minX = Math.min(tl.x, tr.x, br.x, bl.x);
    const maxX = Math.max(tl.x, tr.x, br.x, bl.x);
    const minY = Math.min(tl.y, tr.y, br.y, bl.y);
    const maxY = Math.max(tl.y, tr.y, br.y, bl.y);
    const rect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(rect.width));
    canvas.height = Math.max(1, Math.ceil(rect.height));
    const ctx = canvas.getContext('2d');
    assert(ctx, 'Failed to get canvas context');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const srcW = this.warpSourceCanvas.width;
    const srcH = this.warpSourceCanvas.height;
    const srcPts = [
      { x: 0, y: 0 },
      { x: srcW, y: 0 },
      { x: srcW, y: srcH },
      { x: 0, y: srcH },
    ];
    const dstPts = [
      { x: tl.x - rect.x, y: tl.y - rect.y },
      { x: tr.x - rect.x, y: tr.y - rect.y },
      { x: br.x - rect.x, y: br.y - rect.y },
      { x: bl.x - rect.x, y: bl.y - rect.y },
    ];
    const h = this.computeHomography(srcPts, dstPts);
    if (!this.isValidHomography(h)) {
      ctx.drawImage(this.warpSourceCanvas, 0, 0, canvas.width, canvas.height);
      return { canvas, rect };
    }

    const segments = this.getWarpSegments(srcW, srcH, quality);
    const stepX = srcW / segments;
    const stepY = srcH / segments;

    for (let y = 0; y < segments; y++) {
      for (let x = 0; x < segments; x++) {
        const x0 = x * stepX;
        const x1 = (x + 1) * stepX;
        const y0 = y * stepY;
        const y1 = (y + 1) * stepY;
        const p00 = { x: x0, y: y0 };
        const p10 = { x: x1, y: y0 };
        const p11 = { x: x1, y: y1 };
        const p01 = { x: x0, y: y1 };
        const d00 = this.applyHomography(h, p00);
        const d10 = this.applyHomography(h, p10);
        const d11 = this.applyHomography(h, p11);
        const d01 = this.applyHomography(h, p01);

        this.drawWarpTriangle(ctx, this.warpSourceCanvas, [p00, p10, p11], [d00, d10, d11]);
        this.drawWarpTriangle(ctx, this.warpSourceCanvas, [p00, p11, p01], [d00, d11, d01]);
      }
    }

    return { canvas, rect };
  };

  /**
   * Updates the position of the transformer and the entity.
   * @param arg The position to update to. If omitted, the parent's last stored position will be used.
   */
  updatePosition = (arg?: { position: Coordinate }) => {
    this.log.trace('Updating position');
    const position = get(arg, 'position', this.parent.state.position);

    const pixelRect = this.$pixelRect.get();
    const groupAttrs: Partial<GroupConfig> = {
      x: position.x + pixelRect.x,
      y: position.y + pixelRect.y,
      offsetX: pixelRect.x,
      offsetY: pixelRect.y,
    };
    this.parent.renderer.konva.objectGroup.setAttrs(groupAttrs);
    this.parent.bufferRenderer.konva.group.setAttrs(groupAttrs);

    this.update(position, pixelRect);
  };

  /**
   * Sets the transformer to a specific interaction mode. This internal method shouldn't be used. Instead, use
   * `syncInteractionState` to update the transformer's interaction state.
   *
   * @param interactionMode The mode to set the transformer to. The transformer can be in one of three modes:
   * - 'all': The entity can be moved, resized, and rotated.
   * - 'drag': The entity can be moved.
   * - 'off': The transformer is not interactable.
   */
  _setInteractionMode = (interactionMode: 'all' | 'drag' | 'off') => {
    this.$interactionMode.set(interactionMode);
    if (interactionMode === 'drag') {
      this._enableDrag();
      this._disableTransform();
      this._disableWarp();
      this._showBboxOutline();
    } else if (interactionMode === 'all') {
      if (this.$transformMode.get() === 'warp') {
        this._disableDrag();
        this._disableTransform();
        this._enableWarp();
      } else {
        this._enableDrag();
        this._disableWarp();
        this._enableTransform();
      }
      this._hideBboxOutline();
    } else if (interactionMode === 'off') {
      this._disableDrag();
      this._disableTransform();
      this._disableWarp();
      this._hideBboxOutline();
    }
  };

  updateBbox = () => {
    const nodeRect = this.$nodeRect.get();
    const pixelRect = this.$pixelRect.get();

    this.log.trace({ nodeRect, pixelRect }, 'Updating bbox');

    if (this.$isPendingRectCalculation.get()) {
      this.syncInteractionState();
      return;
    }

    // If the bbox has no width or height, that means the layer is fully transparent. This can happen if it is only
    // eraser lines, fully clipped brush lines or if it has been fully erased.
    if (pixelRect.width === 0 || pixelRect.height === 0) {
      // During transform/processing, bbox can temporarily fail. Do not reset entity state in that case.
      if (!this.$isTransforming.get() && !this.$isProcessing.get()) {
        if (this.parent.renderer.hasObjects()) {
          this.manager.stateApi.resetEntity({ entityIdentifier: this.parent.entityIdentifier });
        }
      }
      this.syncInteractionState();
      return;
    }

    this.syncInteractionState();
    this.update(this.parent.state.position, pixelRect);
    const groupAttrs: Partial<GroupConfig> = {
      x: this.parent.state.position.x + pixelRect.x,
      y: this.parent.state.position.y + pixelRect.y,
      offsetX: pixelRect.x,
      offsetY: pixelRect.y,
    };
    this.parent.renderer.konva.objectGroup.setAttrs(groupAttrs);
    this.parent.bufferRenderer.konva.group.setAttrs(groupAttrs);

    CanvasEntityTransformer.runBboxUpdatedCallbacks(this.parent);
  };

  calculateRect = debounce(() => {
    this.log.debug('Calculating bbox');

    const getCanvasResult = withResult(() => this.parent.getCanvas());
    if (getCanvasResult.isErr()) {
      this.log.error({ error: serializeError(getCanvasResult.error) }, 'Failed to get canvas, resetting bbox');
      this.$nodeRect.set(getEmptyRect());
      this.$pixelRect.set(getEmptyRect());
      this.$isPendingRectCalculation.set(false);
      this.transformMutex.release();
      return;
    }

    const canvas = getCanvasResult.value;

    if (!this.parent.renderer.hasObjects()) {
      this.log.trace('No objects, resetting bbox');
      this.$nodeRect.set(getEmptyRect());
      this.$pixelRect.set(getEmptyRect());
      this.parent.$canvasCache.set(canvas);
      this.$isPendingRectCalculation.set(false);
      this.updateBbox();
      this.transformMutex.release();
      return;
    }

    const rect = this.parent.renderer.konva.objectGroup.getClientRect({ skipTransform: true });

    if (!this.parent.renderer.needsPixelBbox()) {
      this.$nodeRect.set({ ...rect });
      this.$pixelRect.set({ ...rect });
      this.log.trace({ nodeRect: this.$nodeRect.get(), pixelRect: this.$pixelRect.get() }, 'Got bbox from client rect');
      this.parent.$canvasCache.set(canvas);
      this.$isPendingRectCalculation.set(false);
      this.updateBbox();
      this.transformMutex.release();
      return;
    }

    // We have eraser strokes - we must calculate the bbox using pixel data
    const imageData = canvasToImageData(canvas);
    this.manager.worker.requestBbox(
      { buffer: imageData.data.buffer, width: imageData.width, height: imageData.height },
      (extents) => {
        if (extents) {
          const { minX, minY, maxX, maxY } = extents;
          this.$nodeRect.set({ ...rect });
          this.$pixelRect.set({
            x: Math.round(rect.x) + minX,
            y: Math.round(rect.y) + minY,
            width: maxX - minX,
            height: maxY - minY,
          });
        } else {
          // Worker may fail due to blank cache/canvas. Fallback to node rect so we don't treat the layer as empty.
          const fallback = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
          this.$nodeRect.set({ ...rect });
          this.$pixelRect.set(fallback);
        }
        this.log.trace(
          { nodeRect: this.$nodeRect.get(), pixelRect: this.$pixelRect.get(), extents },
          `Got bbox from worker`
        );
        this.parent.$canvasCache.set(canvas);
        this.$isPendingRectCalculation.set(false);
        this.updateBbox();
        this.transformMutex.release();
      }
    );
  }, this.config.RECT_CALC_DEBOUNCE_MS);

  requestRectCalculation = async () => {
    // This will be released when the rect calculation is complete
    await this.transformMutex.acquire();
    this.$isPendingRectCalculation.set(true);
    this.syncInteractionState();
    this.calculateRect();
  };

  // TODO(psyche): After resetting an entity, this can return stale data...
  getRelativeRect = (): Rect => {
    return this.konva.proxyRect.getClientRect({ relativeTo: this.parent.konva.layer });
  };

  _enableTransform = () => {
    this.$isTransformEnabled.set(true);
    this.konva.transformer.visible(true);
    this.konva.transformer.listening(true);
    this.konva.transformer.nodes([this.konva.proxyRect]);
  };

  _disableTransform = () => {
    this.$isTransformEnabled.set(false);
    this.konva.transformer.visible(false);
    this.konva.transformer.listening(false);
    this.konva.transformer.nodes([]);
  };

  _enableDrag = () => {
    this.$isDragEnabled.set(true);
    this.konva.proxyRect.visible(true);
    this.konva.proxyRect.listening(true);
  };

  _disableDrag = () => {
    this.$isDragEnabled.set(false);
    this.konva.proxyRect.visible(false);
    this.konva.proxyRect.listening(false);
  };

  _enableWarp = () => {
    this.konva.warpGroup.visible(true);
    this.konva.warpGroup.listening(true);
    this.konva.warpDragArea.listening(true);
    for (const anchor of Object.values(this.konva.warpAnchors)) {
      anchor.listening(true);
    }
    for (const anchor of Object.values(this.konva.warpSideAnchors)) {
      anchor.listening(true);
    }
    this.parent.renderer.hideObjects();
    if (!this.warpSourceCanvas) {
      this.prepareWarpPreview();
    }
  };

  _disableWarp = () => {
    this.konva.warpGroup.visible(false);
    this.konva.warpGroup.listening(false);
    this.konva.warpDragArea.listening(false);
    for (const anchor of Object.values(this.konva.warpAnchors)) {
      anchor.listening(false);
    }
    for (const anchor of Object.values(this.konva.warpSideAnchors)) {
      anchor.listening(false);
    }
  };

  _showBboxOutline = () => {
    this.konva.outlineRect.visible(true);
  };

  _hideBboxOutline = () => {
    this.konva.outlineRect.visible(false);
  };

  static registerBboxUpdatedCallback = (callback: LifecycleCallback) => {
    const wrapped = async (adapter: CanvasEntityAdapter) => {
      const result = await callback(adapter);
      if (result) {
        this.bboxUpdatedCallbacks.delete(wrapped);
      }
      return result;
    };
    this.bboxUpdatedCallbacks.add(wrapped);
  };

  private static runBboxUpdatedCallbacks = (adapter: CanvasEntityAdapter) => {
    for (const callback of this.bboxUpdatedCallbacks) {
      callback(adapter);
    }
  };

  repr = () => {
    return {
      id: this.id,
      type: this.type,
      path: this.path,
      config: this.config,
      $nodeRect: this.$nodeRect.get(),
      $pixelRect: this.$pixelRect.get(),
      $isPendingRectCalculation: this.$isPendingRectCalculation.get(),
      $isTransforming: this.$isTransforming.get(),
      $transformMode: this.$transformMode.get(),
      $interactionMode: this.$interactionMode.get(),
      $isDragEnabled: this.$isDragEnabled.get(),
      $isTransformEnabled: this.$isTransformEnabled.get(),
      $isProcessing: this.$isProcessing.get(),
      konva: {
        transformer: getKonvaNodeDebugAttrs(this.konva.transformer),
        proxyRect: getKonvaNodeDebugAttrs(this.konva.proxyRect),
        outlineRect: getKonvaNodeDebugAttrs(this.konva.outlineRect),
        warpGroup: getKonvaNodeDebugAttrs(this.konva.warpGroup),
      },
    };
  };

  destroy = () => {
    this.log.debug('Destroying module');
    this.subscriptions.forEach((unsubscribe) => unsubscribe());
    this.subscriptions.clear();
    this.konva.outlineRect.destroy();
    this.konva.transformer.destroy();
    this.konva.proxyRect.destroy();
    this.konva.warpGroup.destroy();
  };
}
