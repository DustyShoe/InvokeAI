import { Flex } from '@invoke-ai/ui-library';
import { StagingAreaItemsList } from 'features/controlLayers/components/StagingArea/StagingAreaItemsList';
import { StagingAreaToolbar } from 'features/controlLayers/components/StagingArea/StagingAreaToolbar';
import { selectShowStagingThumbnails } from 'features/controlLayers/store/canvasSettingsSlice';
import { useCanvasIsStaging } from 'features/controlLayers/store/canvasStagingAreaSlice';
import { useAppSelector } from 'app/store/storeHooks';
import { memo } from 'react';

export const StagingArea = memo(() => {
  const isStaging = useCanvasIsStaging();
  const showStagingThumbnails = useAppSelector(selectShowStagingThumbnails);

  if (!isStaging) {
    return null;
  }

  return (
    <Flex position="absolute" flexDir="column" bottom={2} gap={2} align="center" justify="center" left={2} right={2}>
      {showStagingThumbnails && <StagingAreaItemsList />}
      <StagingAreaToolbar />
    </Flex>
  );
});
StagingArea.displayName = 'StagingArea';
