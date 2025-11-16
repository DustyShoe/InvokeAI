import { ButtonGroup, CompositeNumberInput, Flex, IconButton, Select } from '@invoke-ai/ui-library';
import { useClipboard } from 'common/hooks/useClipboard';
import { useCanvasManager } from 'features/controlLayers/contexts/CanvasManagerProviderGate';
import type { CanvasTextFontFamily } from 'features/controlLayers/store/types';
import { useStore } from '@nanostores/react';
import { clamp } from 'es-toolkit/compat';
import { useTranslation } from 'react-i18next';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect } from 'react';
import {
  PiTextAlignCenterBold,
  PiTextAlignLeftBold,
  PiTextAlignRightBold,
  PiTextBBold,
  PiTextItalicBold,
} from 'react-icons/pi';

const DEFAULT_FONT_SIZE = 48;

export const TextToolOptions = memo(() => {
  const canvasManager = useCanvasManager();
  const settings = useStore(canvasManager.tool.tools.text.$settings);
  const { t } = useTranslation('translation', { keyPrefix: 'controlLayers.textTool' });
  const clipboard = useClipboard();
  const { readText, writeText } = clipboard;

  const onFontSizeChange = useCallback(
    (value: number) => {
      const fontSize = clamp(Math.round(value || settings.fontSize), 4, 400);
      canvasManager.tool.tools.text.setFontSize(fontSize);
    },
    [canvasManager.tool.tools.text, settings.fontSize]
  );

  const onFontFamilyChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      canvasManager.tool.tools.text.setFontFamily(e.target.value as CanvasTextFontFamily);
    },
    [canvasManager.tool.tools.text]
  );

  const onAlignChange = useCallback(
    (align: 'left' | 'center' | 'right') => () => {
      canvasManager.tool.tools.text.setAlign(align);
    },
    [canvasManager.tool.tools.text]
  );

  const toggleBold = useCallback(() => {
    canvasManager.tool.tools.text.toggleBold();
  }, [canvasManager.tool.tools.text]);

  const toggleItalic = useCallback(() => {
    canvasManager.tool.tools.text.toggleItalic();
  }, [canvasManager.tool.tools.text]);

  useEffect(() => {
    canvasManager.tool.tools.text.setClipboardHandlers({
      writeText,
      readText: async () => {
        if (!readText) {
          return null;
        }

        return await readText();
      },
    });

    return () => {
      canvasManager.tool.tools.text.clearClipboardHandlers();
    };
  }, [canvasManager.tool.tools.text, readText, writeText]);

  return (
    <Flex alignItems="center" h="full" gap={2} px={2} flexWrap="nowrap">
      <CompositeNumberInput
        min={4}
        max={400}
        value={settings.fontSize}
        onChange={onFontSizeChange}
        defaultValue={DEFAULT_FONT_SIZE}
        aria-label={t('fontSize')}
        w="80px"
        minW="80px"
        maxW="80px"
        flexShrink={0}
      />
      <Select
        value={settings.fontFamily}
        onChange={onFontFamilyChange}
        size="md"
        aria-label={t('fontFamily')}
        w="180px"
        minW="180px"
        maxW="200px"
        flexShrink={0}
        sx={{
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}
      >
        <option value="sans">{t('fontFamilyOptions.sans')}</option>
        <option value="serif">{t('fontFamilyOptions.serif')}</option>
        <option value="mono">{t('fontFamilyOptions.mono')}</option>
      </Select>
      <ButtonGroup isAttached alignSelf="stretch">
        <IconButton
          aria-label={t('bold')}
          icon={<PiTextBBold />}
          variant={settings.isBold ? 'solid' : 'outline'}
          colorScheme={settings.isBold ? 'invokeBlue' : 'base'}
          onClick={toggleBold}
        />
        <IconButton
          aria-label={t('italic')}
          icon={<PiTextItalicBold />}
          variant={settings.isItalic ? 'solid' : 'outline'}
          colorScheme={settings.isItalic ? 'invokeBlue' : 'base'}
          onClick={toggleItalic}
        />
      </ButtonGroup>
      <ButtonGroup isAttached alignSelf="stretch">
        <IconButton
          aria-label={t('alignLeft')}
          icon={<PiTextAlignLeftBold />}
          variant={settings.align === 'left' ? 'solid' : 'outline'}
          colorScheme={settings.align === 'left' ? 'invokeBlue' : 'base'}
          onClick={onAlignChange('left')}
        />
        <IconButton
          aria-label={t('alignCenter')}
          icon={<PiTextAlignCenterBold />}
          variant={settings.align === 'center' ? 'solid' : 'outline'}
          colorScheme={settings.align === 'center' ? 'invokeBlue' : 'base'}
          onClick={onAlignChange('center')}
        />
        <IconButton
          aria-label={t('alignRight')}
          icon={<PiTextAlignRightBold />}
          variant={settings.align === 'right' ? 'solid' : 'outline'}
          colorScheme={settings.align === 'right' ? 'invokeBlue' : 'base'}
          onClick={onAlignChange('right')}
        />
      </ButtonGroup>
    </Flex>
  );
});

TextToolOptions.displayName = 'TextToolOptions';
