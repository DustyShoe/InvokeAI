import type { CanvasTextFontFamily } from 'features/controlLayers/store/types';

export const TEXT_TOOL_FONT_FAMILY_MAP: Record<CanvasTextFontFamily, string> = {
  sans: 'Inter, system-ui, sans-serif',
  serif: 'Georgia, serif',
  mono: 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
};

export const TEXT_TOOL_LINE_HEIGHT = 1.2;

export const getFontStyle = (arg: { isBold: boolean; isItalic: boolean }): string => {
  const { isBold, isItalic } = arg;
  if (isBold && isItalic) {
    return 'italic bold';
  }
  if (isBold) {
    return 'bold';
  }
  if (isItalic) {
    return 'italic';
  }
  return 'normal';
};
