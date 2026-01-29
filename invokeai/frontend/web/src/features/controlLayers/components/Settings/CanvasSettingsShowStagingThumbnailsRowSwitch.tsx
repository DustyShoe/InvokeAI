import { FormControl, FormLabel, Switch } from '@invoke-ai/ui-library';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import {
  selectShowStagingThumbnailsRow,
  settingsShowStagingThumbnailsRowToggled,
} from 'features/controlLayers/store/canvasSettingsSlice';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export const CanvasSettingsShowStagingThumbnailsRowSwitch = memo(() => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const showStagingThumbnailsRow = useAppSelector(selectShowStagingThumbnailsRow);
  const onChange = useCallback(() => {
    dispatch(settingsShowStagingThumbnailsRowToggled());
  }, [dispatch]);

  return (
    <FormControl>
      <FormLabel m={0} flexGrow={1}>
        {t('controlLayers.settings.showStagingThumbnailsRow')}
      </FormLabel>
      <Switch size="sm" isChecked={showStagingThumbnailsRow} onChange={onChange} />
    </FormControl>
  );
});

CanvasSettingsShowStagingThumbnailsRowSwitch.displayName = 'CanvasSettingsShowStagingThumbnailsRowSwitch';
