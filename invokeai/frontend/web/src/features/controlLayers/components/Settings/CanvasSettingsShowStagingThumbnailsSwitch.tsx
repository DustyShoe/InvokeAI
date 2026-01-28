import { FormControl, FormLabel, Switch } from '@invoke-ai/ui-library';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import {
  selectShowStagingThumbnails,
  settingsShowStagingThumbnailsToggled,
} from 'features/controlLayers/store/canvasSettingsSlice';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export const CanvasSettingsShowStagingThumbnailsSwitch = memo(() => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const showStagingThumbnails = useAppSelector(selectShowStagingThumbnails);
  const onChange = useCallback(() => {
    dispatch(settingsShowStagingThumbnailsToggled());
  }, [dispatch]);

  return (
    <FormControl>
      <FormLabel m={0} flexGrow={1}>
        {t('controlLayers.showStagingThumbnails')}
      </FormLabel>
      <Switch size="sm" isChecked={showStagingThumbnails} onChange={onChange} />
    </FormControl>
  );
});

CanvasSettingsShowStagingThumbnailsSwitch.displayName = 'CanvasSettingsShowStagingThumbnailsSwitch';
