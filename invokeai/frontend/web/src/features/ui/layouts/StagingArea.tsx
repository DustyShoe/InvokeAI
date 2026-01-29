import { Flex } from '@invoke-ai/ui-library';
import { useCanvasManager } from 'features/controlLayers/contexts/CanvasManagerProviderGate';
import { useStagingAreaContext } from 'features/controlLayers/components/StagingArea/context';
import { StagingAreaItemsList } from 'features/controlLayers/components/StagingArea/StagingAreaItemsList';
import { StagingAreaToolbar } from 'features/controlLayers/components/StagingArea/StagingAreaToolbar';
import { selectShowStagingThumbnailsRow } from 'features/controlLayers/store/canvasSettingsSlice';
import { useCanvasIsStaging } from 'features/controlLayers/store/canvasStagingAreaSlice';
import { useAppSelector } from 'app/store/storeHooks';
import { memo, useEffect } from 'react';

export const StagingArea = memo(() => {
  const isStaging = useCanvasIsStaging();
  const showStagingThumbnailsRow = useAppSelector(selectShowStagingThumbnailsRow);
  const canvasManager = useCanvasManager();
  const ctx = useStagingAreaContext();

  useEffect(() => {
    return canvasManager.stagingArea.connectToSession(ctx.$items, ctx.$selectedItem);
  }, [canvasManager, ctx.$items, ctx.$selectedItem]);

  if (!isStaging) {
    return null;
  }

  return (
    <Flex position="absolute" flexDir="column" bottom={2} gap={2} align="center" justify="center" left={2} right={2}>
      {showStagingThumbnailsRow ? <StagingAreaItemsList /> : null}
      <StagingAreaToolbar />
    </Flex>
  );
});
StagingArea.displayName = 'StagingArea';
