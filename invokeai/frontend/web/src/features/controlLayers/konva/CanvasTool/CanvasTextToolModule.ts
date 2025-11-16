import { rgbaColorToString } from 'common/util/colorCodeTransformers';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import type { CanvasToolModule } from 'features/controlLayers/konva/CanvasTool/CanvasToolModule';
import { TEXT_TOOL_FONT_FAMILY_MAP, TEXT_TOOL_LINE_HEIGHT, getFontStyle } from 'features/controlLayers/konva/text/textToolConstants';
import { floorCoord, getPrefixedId, offsetCoord } from 'features/controlLayers/konva/util';
import type { CanvasEntityAdapter } from 'features/controlLayers/konva/CanvasEntity/types';
import type { CanvasEntityIdentifier, CanvasTextAlign, CanvasTextFontFamily, Coordinate } from 'features/controlLayers/store/types';
import { atom } from 'nanostores';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Logger } from 'roarr';

const CARET_BLINK_MS = 500;
const CARET_SCREEN_WIDTH = 1.5; // px on screen

type TextToolSettings = {
  fontSize: number;
  fontFamily: CanvasTextFontFamily;
  isBold: boolean;
  isItalic: boolean;
  align: CanvasTextAlign;
};

const DEFAULT_SETTINGS: TextToolSettings = {
  fontSize: 48,
  fontFamily: 'sans',
  isBold: false,
  isItalic: false,
  align: 'left',
};

type TextEditingState = {
  position: Coordinate;
  entityIdentifier: CanvasEntityIdentifier;
  text: string;
};

export class CanvasTextToolModule extends CanvasModuleBase {
  readonly type = 'text_tool';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasToolModule;
  readonly manager: CanvasManager;
  readonly log: Logger;

  $settings = atom<TextToolSettings>(DEFAULT_SETTINGS);
  $editingState = atom<TextEditingState | null>(null);

  private readonly isMacPlatform = (() => {
    if (typeof navigator === 'undefined') {
      return false;
    }

    const uaPlatform = navigator.userAgentData?.platform?.toLowerCase();
    const legacyPlatform = navigator.platform?.toLowerCase();

    return Boolean(uaPlatform?.includes('mac') || legacyPlatform?.includes('mac'));
  })();

  private measureCtx: CanvasRenderingContext2D;
  private caretInterval: number | null = null;
  private isCaretVisible = true;

  konva: {
    group: Konva.Group;
    previewCaret: Konva.Rect;
    editingGroup: Konva.Group;
    editingText: Konva.Text;
    editingCaret: Konva.Rect;
  };

  constructor(parent: CanvasToolModule) {
    super();
    this.id = getPrefixedId(this.type);
    this.parent = parent;
    this.manager = this.parent.manager;
    this.path = this.manager.buildPath(this);
    this.log = this.manager.buildLogger(this);

    this.log.debug('Creating text tool module');

    const measureCanvas = document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to create measurement context for text tool');
    }
    this.measureCtx = ctx;

    const caretWidth = this.manager.stage.unscale(CARET_SCREEN_WIDTH);

    this.konva = {
      group: new Konva.Group({ name: `${this.type}:group`, listening: false }),
      previewCaret: new Konva.Rect({
        name: `${this.type}:preview_caret`,
        listening: false,
        width: caretWidth,
        height: DEFAULT_SETTINGS.fontSize,
        offsetX: caretWidth / 2,
        fill: rgbaColorToString(this.manager.stateApi.getCurrentColor()),
        visible: false,
      }),
      editingGroup: new Konva.Group({ name: `${this.type}:editing_group`, listening: false, visible: false }),
      editingText: new Konva.Text({
        name: `${this.type}:editing_text`,
        listening: false,
        lineHeight: TEXT_TOOL_LINE_HEIGHT,
      }),
      editingCaret: new Konva.Rect({
        name: `${this.type}:editing_caret`,
        listening: false,
        width: caretWidth,
        offsetX: caretWidth / 2,
        fill: rgbaColorToString(this.manager.stateApi.getCurrentColor()),
      }),
    };

    this.konva.group.add(this.konva.previewCaret);
    this.konva.editingGroup.add(this.konva.editingText);
    this.konva.editingGroup.add(this.konva.editingCaret);
    this.konva.group.add(this.konva.editingGroup);

    this.$settings.listen(this.render);
    this.$editingState.listen(this.render);
  }

  syncCursorStyle = () => {
    this.manager.stage.setCursor('none');
  };

  onStagePointerEnter = (_e: KonvaEventObject<PointerEvent>) => {
    this.render();
  };

  onStagePointerMove = (_e: KonvaEventObject<PointerEvent>) => {
    this.render();
  };

  onStagePointerDown = (e: KonvaEventObject<PointerEvent>) => {
    if (e.evt.button !== 0) {
      // Only left clicks start text editing; right/middle clicks keep their existing behaviors.
      return;
    }

    if (!this.manager.tool.getCanDraw()) {
      return;
    }

    if (this.$editingState.get()) {
      // Ignore clicks while editing in v1 - commit/cancel is keyboard-only.
      return;
    }

    const cursorPos = this.parent.$cursorPos.get();
    const selectedEntity = this.manager.stateApi.getSelectedEntityAdapter();

    if (!cursorPos || !selectedEntity) {
      return;
    }

    const normalizedPoint = floorCoord(offsetCoord(cursorPos.relative, selectedEntity.state.position));

    this.startEditing(selectedEntity, normalizedPoint);
    this.render();
  };

  onStagePointerLeave = (_e: PointerEvent) => {
    if (!this.$editingState.get()) {
      this.konva.previewCaret.visible(false);
      this.konva.editingGroup.visible(false);
      this.manager.konva.previewLayer.batchDraw();
    }
  };

  onKeyDown = (e: KeyboardEvent): boolean => {
    if (this.parent.$tool.get() !== 'text') {
      return false;
    }

    const editingState = this.$editingState.get();

    if (!editingState) {
      return false;
    }

    const consumeKeyEvent = () => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
    };

    const isPrimaryModifier = this.isPrimaryModifierPressed(e);
    const key = e.key.toLowerCase();

    if (isPrimaryModifier && !e.shiftKey && !e.altKey) {
      if (key === 'c') {
        consumeKeyEvent();
        this.copyText(editingState.text);
        return true;
      }

      if (key === 'v') {
        consumeKeyEvent();
        void this.pasteFromClipboard();
        return true;
      }

      if (key === 'x') {
        consumeKeyEvent();
        this.cutText();
        return true;
      }

      if (key === 'y') {
        consumeKeyEvent();
        this.redoEditing();
        return true;
      }
    }

    if (e.key === 'Escape') {
      consumeKeyEvent();
      this.cancelEditing();
      return true;
    }

    if (e.key === 'Enter' && e.shiftKey) {
      consumeKeyEvent();
      this.appendToEditingState('\n');
      return true;
    }

    if (e.key === 'Enter') {
      consumeKeyEvent();
      this.finalizeEditing();
      return true;
    }

    if (e.key === 'Backspace') {
      consumeKeyEvent();
      const newText = editingState.text.slice(0, -1);
      this.$editingState.set({ ...editingState, text: newText });
      this.resetCaretBlink();
      return true;
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      consumeKeyEvent();
      this.appendToEditingState(e.key);
      return true;
    }

    // Swallow all other hotkeys while editing text so only text entry controls apply.
    consumeKeyEvent();
    return true;
  };

  onKeyUp = (e: KeyboardEvent): boolean => {
    if (this.parent.$tool.get() !== 'text') {
      return false;
    }

    if (!this.$editingState.get()) {
      return false;
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();

    // No additional behavior on keyup; we simply block other hotkeys while typing.
    return true;
  };

  onToolChanged = (prevTool: string, nextTool: string) => {
    if (prevTool === 'text' && nextTool !== 'text') {
      // Switching tools finalizes the current text entry.
      this.finalizeEditing();
    }
  };

  setFontSize = (fontSize: number) => {
    const current = this.$settings.get();
    this.$settings.set({ ...current, fontSize });
    this.resetCaretBlink();
  };

  setFontFamily = (fontFamily: CanvasTextFontFamily) => {
    const current = this.$settings.get();
    this.$settings.set({ ...current, fontFamily });
    this.resetCaretBlink();
  };

  toggleBold = () => {
    const current = this.$settings.get();
    this.$settings.set({ ...current, isBold: !current.isBold });
    this.resetCaretBlink();
  };

  toggleItalic = () => {
    const current = this.$settings.get();
    this.$settings.set({ ...current, isItalic: !current.isItalic });
    this.resetCaretBlink();
  };

  setAlign = (align: CanvasTextAlign) => {
    const current = this.$settings.get();
    this.$settings.set({ ...current, align });
    this.resetCaretBlink();
  };

  render = () => {
    if (this.parent.$tool.get() !== 'text') {
      this.hideAll();
      return;
    }

    const editingState = this.$editingState.get();

    if (editingState) {
      this.renderEditing(editingState);
    } else {
      this.renderPreview();
    }

    this.manager.konva.previewLayer.batchDraw();
  };

  private hideAll = () => {
    this.konva.previewCaret.visible(false);
    this.konva.editingGroup.visible(false);
  };

  private renderPreview = () => {
    const cursorPos = this.parent.$cursorPos.get();
    if (!cursorPos) {
      this.konva.previewCaret.visible(false);
      return;
    }

    if (!this.manager.tool.getCanDraw()) {
      this.konva.previewCaret.visible(false);
      return;
    }

    const settings = this.$settings.get();
    const color = this.manager.stateApi.getCurrentColor();
    const caretWidth = this.manager.stage.unscale(CARET_SCREEN_WIDTH);

    this.konva.previewCaret.setAttrs({
      x: cursorPos.relative.x,
      y: cursorPos.relative.y,
      height: settings.fontSize,
      width: caretWidth,
      offsetX: caretWidth / 2,
      fill: rgbaColorToString({ ...color, a: 1 }),
      visible: true,
    });

    this.konva.editingGroup.visible(false);
  };

  private renderEditing = (editingState: TextEditingState) => {
    const settings = this.$settings.get();
    const color = this.manager.stateApi.getCurrentColor();
    const fontStyle = getFontStyle(settings);
    const cssFontFamily = TEXT_TOOL_FONT_FAMILY_MAP[settings.fontFamily];
    const metrics = this.measureText(editingState.text, settings);
    const caretWidth = this.manager.stage.unscale(CARET_SCREEN_WIDTH);

    this.konva.editingText.setAttrs({
      x: editingState.position.x,
      y: editingState.position.y,
      text: editingState.text,
      fontSize: settings.fontSize,
      fontFamily: cssFontFamily,
      fontStyle,
      align: settings.align,
      lineHeight: TEXT_TOOL_LINE_HEIGHT,
      width: metrics.width || undefined,
      height: metrics.height || undefined,
      fill: rgbaColorToString({ ...color, a: 1 }),
    });

    const effectiveWidth = metrics.width || this.konva.editingText.width();
    if (settings.align === 'center') {
      this.konva.editingText.offsetX(effectiveWidth / 2);
    } else if (settings.align === 'right') {
      this.konva.editingText.offsetX(effectiveWidth);
    } else {
      this.konva.editingText.offsetX(0);
    }

    const caretPosition = this.getCaretPosition(editingState.text, editingState.position, settings, metrics.lastLineWidth);
    this.konva.editingCaret.setAttrs({
      x: caretPosition.x,
      y: caretPosition.y,
      height: settings.fontSize,
      width: caretWidth,
      offsetX: caretWidth / 2,
      fill: rgbaColorToString({ ...color, a: 1 }),
      visible: this.isCaretVisible,
    });

    this.konva.editingGroup.visible(true);
    this.konva.previewCaret.visible(false);
  };

  private getCaretPosition = (
    text: string,
    position: Coordinate,
    settings: TextToolSettings,
    lastLineWidth: number
  ): Coordinate => {
    const lines = text.split('\n');
    const lineIndex = Math.max(lines.length - 1, 0);
    const y = position.y + lineIndex * settings.fontSize * TEXT_TOOL_LINE_HEIGHT;
    const x = position.x + this.getAlignmentOffset(settings.align, lastLineWidth);
    return { x, y };
  };

  private measureText = (text: string, settings: TextToolSettings) => {
    const fontFamily = TEXT_TOOL_FONT_FAMILY_MAP[settings.fontFamily];
    this.measureCtx.font = `${getFontStyle(settings)} ${settings.fontSize}px ${fontFamily}`.trim();
    const lines = text.split('\n');
    let width = 0;
    let lastLineWidth = 0;

    lines.forEach((line, index) => {
      const measured = this.measureCtx.measureText(line || ' ');
      width = Math.max(width, measured.width);
      if (index === lines.length - 1) {
        lastLineWidth = measured.width;
      }
    });

    const height = Math.max(lines.length, 1) * settings.fontSize * TEXT_TOOL_LINE_HEIGHT;

    return { width, height, lastLineWidth };
  };

  private getAlignmentOffset = (align: CanvasTextAlign, width: number) => {
    if (align === 'center') {
      return -(width / 2);
    }
    if (align === 'right') {
      return -width;
    }
    return 0;
  };

  private isPrimaryModifierPressed = (e: KeyboardEvent) => {
    return this.isMacPlatform ? e.metaKey : e.ctrlKey;
  };

  private copyText = (text: string) => {
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return;
    }

    void navigator.clipboard.writeText(text).catch((error) => {
      this.log.warn({ error }, 'Unable to copy text from text tool');
    });
  };

  private pasteFromClipboard = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
      return;
    }

    try {
      const clipboardText = await navigator.clipboard.readText();
      if (!clipboardText) {
        return;
      }

      const editingState = this.$editingState.get();
      if (!editingState) {
        return;
      }

      this.$editingState.set({ ...editingState, text: `${editingState.text}${clipboardText}` });
      this.resetCaretBlink();
    } catch (error) {
      this.log.warn({ error }, 'Unable to paste text into text tool');
    }
  };

  private cutText = () => {
    const editingState = this.$editingState.get();
    if (!editingState || !editingState.text) {
      return;
    }

    this.copyText(editingState.text);
    this.$editingState.set({ ...editingState, text: '' });
    this.resetCaretBlink();
  };

  private redoEditing = () => {
    // Placeholder to consume redo hotkeys while editing. In v1, text editing does not track a redo stack.
  };

  private appendToEditingState = (value: string) => {
    const editingState = this.$editingState.get();
    if (!editingState) {
      return;
    }
    this.$editingState.set({ ...editingState, text: `${editingState.text}${value}` });
    this.resetCaretBlink();
  };

  private startEditing = (entity: CanvasEntityAdapter, position: Coordinate) => {
    this.$editingState.set({
      entityIdentifier: entity.entityIdentifier,
      position,
      text: '',
    });
    this.startCaretBlink();
  };

  private finalizeEditing = () => {
    const editingState = this.$editingState.get();
    if (!editingState) {
      return;
    }

    const text = editingState.text;
    if (!text.trim()) {
      this.cancelEditing();
      return;
    }

    const settings = this.$settings.get();
    const metrics = this.measureText(text, settings);
    const entityIdentifier = editingState.entityIdentifier;
    const color = this.manager.stateApi.getCurrentColor();

    this.manager.stateApi.addText({
      entityIdentifier,
      text: {
        id: getPrefixedId('text'),
        type: 'text',
        position: editingState.position,
        text,
        fontSize: settings.fontSize,
        fontFamily: settings.fontFamily,
        isBold: settings.isBold,
        isItalic: settings.isItalic,
        align: settings.align,
        color: { ...color, a: 1 },
        width: metrics.width,
        height: metrics.height,
        lineHeight: TEXT_TOOL_LINE_HEIGHT,
      },
    });

    this.clearEditing();
  };

  private cancelEditing = () => {
    this.clearEditing();
  };

  private clearEditing = () => {
    this.$editingState.set(null);
    this.stopCaretBlink();
    this.konva.editingGroup.visible(false);
  };

  private startCaretBlink = () => {
    this.stopCaretBlink();
    this.isCaretVisible = true;
    this.caretInterval = window.setInterval(() => {
      this.isCaretVisible = !this.isCaretVisible;
      this.konva.editingCaret.visible(this.isCaretVisible);
      this.manager.konva.previewLayer.batchDraw();
    }, CARET_BLINK_MS);
  };

  private stopCaretBlink = () => {
    if (this.caretInterval !== null) {
      window.clearInterval(this.caretInterval);
      this.caretInterval = null;
    }
    this.isCaretVisible = true;
  };

  private resetCaretBlink = () => {
    if (this.$editingState.get()) {
      this.startCaretBlink();
    }
  };

  destroy = () => {
    this.log.debug('Destroying text tool module');
    this.stopCaretBlink();
    this.konva.group.destroy();
  };

  repr = () => {
    return {
      id: this.id,
      type: this.type,
      path: this.path,
      settings: this.$settings.get(),
      editingState: this.$editingState.get(),
    };
  };
}
