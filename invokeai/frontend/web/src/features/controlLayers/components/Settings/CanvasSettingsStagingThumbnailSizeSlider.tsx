import { CompositeSlider, FormControl, FormLabel } from '@invoke-ai/ui-library';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import {
  selectShowStagingThumbnails,
  selectStagingThumbnailSize,
  settingsStagingThumbnailSizeChanged,
} from 'features/controlLayers/store/canvasSettingsSlice';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export const CanvasSettingsStagingThumbnailSizeSlider = memo(() => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const showStagingThumbnails = useAppSelector(selectShowStagingThumbnails);
  const stagingThumbnailSize = useAppSelector(selectStagingThumbnailSize);

  const onChange = useCallback(
    (value: number) => {
      dispatch(settingsStagingThumbnailSizeChanged(value));
    },
    [dispatch]
  );

  return (
    <FormControl isDisabled={!showStagingThumbnails}>
      <FormLabel>{t('controlLayers.stagingThumbnailSize')}</FormLabel>
      <CompositeSlider
        value={stagingThumbnailSize}
        onChange={onChange}
        min={50}
        max={200}
        defaultValue={72}
        step={1}
      />
    </FormControl>
  );
});

CanvasSettingsStagingThumbnailSizeSlider.displayName = 'CanvasSettingsStagingThumbnailSizeSlider';
