import { IconButton, Tooltip } from '@invoke-ai/ui-library';
import { useSelectTool, useToolIsSelected } from 'features/controlLayers/components/Tool/hooks';
import { useRegisteredHotkeys } from 'features/system/components/HotkeysModal/useHotkeyData';
import { useTranslation } from 'react-i18next';
import { memo, useMemo } from 'react';
import { PiTextTBold } from 'react-icons/pi';

export const ToolTextButton = memo(() => {
  const isSelected = useToolIsSelected('text');
  const selectText = useSelectTool('text');
  const { t } = useTranslation('translation', { keyPrefix: 'controlLayers.textTool' });
  const label = useMemo(() => `${t('label')} (Y)`, [t]);

  useRegisteredHotkeys({
    id: 'selectTextTool',
    category: 'canvas',
    callback: selectText,
    options: { enabled: !isSelected },
    dependencies: [isSelected, selectText],
  });

  return (
    <Tooltip label={label} placement="end">
      <IconButton
        aria-label={label}
        icon={<PiTextTBold />}
        colorScheme={isSelected ? 'invokeBlue' : 'base'}
        variant="solid"
        onClick={selectText}
      />
    </Tooltip>
  );
});

ToolTextButton.displayName = 'ToolTextButton';
