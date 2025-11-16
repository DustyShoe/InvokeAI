import { rgbaColorToString } from 'common/util/colorCodeTransformers';
import { deepClone } from 'common/util/deepClone';
import { TEXT_TOOL_FONT_FAMILY_MAP, TEXT_TOOL_LINE_HEIGHT, getFontStyle } from 'features/controlLayers/konva/text/textToolConstants';
import type { CanvasEntityBufferObjectRenderer } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityBufferObjectRenderer';
import type { CanvasEntityObjectRenderer } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityObjectRenderer';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import type { CanvasTextState } from 'features/controlLayers/store/types';
import Konva from 'konva';
import type { Logger } from 'roarr';

export class CanvasObjectText extends CanvasModuleBase {
  readonly type = 'object_text';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasEntityObjectRenderer | CanvasEntityBufferObjectRenderer;
  readonly manager: CanvasManager;
  readonly log: Logger;

  state: CanvasTextState;
  konva: {
    group: Konva.Group;
    text: Konva.Text;
  };

  constructor(state: CanvasTextState, parent: CanvasEntityObjectRenderer | CanvasEntityBufferObjectRenderer) {
    super();
    this.id = state.id;
    this.parent = parent;
    this.manager = parent.manager;
    this.path = this.manager.buildPath(this);
    this.log = this.manager.buildLogger(this);

    this.log.debug({ state }, 'Creating text object');

    this.konva = {
      group: new Konva.Group({ name: `${this.type}:group`, listening: false }),
      text: new Konva.Text({ name: `${this.type}:text`, listening: false, perfectDrawEnabled: false }),
    };
    this.konva.group.add(this.konva.text);
    this.state = state;
  }

  update(state: CanvasTextState, force = false): boolean {
    if (force || this.state !== state) {
      this.log.trace({ state }, 'Updating text');
      const { position, text, fontSize, fontFamily, isBold, isItalic, align, color, width, lineHeight, height } = state;
      const fontStyle = getFontStyle({ isBold, isItalic });
      const cssFontFamily = TEXT_TOOL_FONT_FAMILY_MAP[fontFamily];
      this.konva.text.setAttrs({
        x: position.x,
        y: position.y,
        text,
        fontSize,
        fontFamily: cssFontFamily,
        fontStyle,
        lineHeight,
        align,
        width: width || undefined,
        height: height || undefined,
        fill: rgbaColorToString({ ...color, a: 1 }),
      });

      const effectiveWidth = width || this.konva.text.width();
      if (align === 'center') {
        this.konva.text.offsetX(effectiveWidth / 2);
      } else if (align === 'right') {
        this.konva.text.offsetX(effectiveWidth);
      } else {
        this.konva.text.offsetX(0);
      }

      // Ensure line height is set consistently even if text is empty
      this.konva.text.lineHeight(lineHeight || TEXT_TOOL_LINE_HEIGHT);

      this.state = state;
      return true;
    }

    return false;
  }

  destroy = () => {
    this.log.debug('Destroying text object');
    this.konva.group.destroy();
  };

  repr = () => {
    return {
      id: this.id,
      type: this.type,
      path: this.path,
      parent: this.parent.id,
      state: deepClone(this.state),
    };
  };
}
