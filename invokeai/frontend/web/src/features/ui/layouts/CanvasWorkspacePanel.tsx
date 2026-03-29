import { Box, ContextMenu, Divider, Flex, IconButton, Menu, MenuButton, MenuList } from '@invoke-ai/ui-library';
import { useAppSelector } from 'app/store/storeHooks';
import { CanvasAlertsBboxVisibility } from 'features/controlLayers/components/CanvasAlerts/CanvasAlertsBboxVisibility';
import { CanvasAlertsInvocationProgress } from 'features/controlLayers/components/CanvasAlerts/CanvasAlertsInvocationProgress';
import { CanvasAlertsPreserveMask } from 'features/controlLayers/components/CanvasAlerts/CanvasAlertsPreserveMask';
import { CanvasAlertsSaveAllImagesToGallery } from 'features/controlLayers/components/CanvasAlerts/CanvasAlertsSaveAllImagesToGallery';
import { CanvasAlertsSelectedEntityStatus } from 'features/controlLayers/components/CanvasAlerts/CanvasAlertsSelectedEntityStatus';
import { CanvasAlertsTextSessionActive } from 'features/controlLayers/components/CanvasAlerts/CanvasAlertsTextSessionActive';
import { CanvasBusySpinner } from 'features/controlLayers/components/CanvasBusySpinner';
import { CanvasContextMenuGlobalMenuItems } from 'features/controlLayers/components/CanvasContextMenu/CanvasContextMenuGlobalMenuItems';
import { CanvasContextMenuSelectedEntityMenuItems } from 'features/controlLayers/components/CanvasContextMenu/CanvasContextMenuSelectedEntityMenuItems';
import { CanvasDropArea } from 'features/controlLayers/components/CanvasDropArea';
import { Filter } from 'features/controlLayers/components/Filters/Filter';
import { CanvasHUD } from 'features/controlLayers/components/HUD/CanvasHUD';
import { InvokeCanvasComponent } from 'features/controlLayers/components/InvokeCanvasComponent';
import { SelectObject } from 'features/controlLayers/components/SelectObject/SelectObject';
import { StagingAreaContextProvider } from 'features/controlLayers/components/StagingArea/context';
import { CanvasTextOverlay } from 'features/controlLayers/components/Text/CanvasTextOverlay';
import { PinnedFillColorPickerOverlay } from 'features/controlLayers/components/Tool/PinnedFillColorPickerOverlay';
import { CanvasToolbar } from 'features/controlLayers/components/Toolbar/CanvasToolbar';
import { Transform } from 'features/controlLayers/components/Transform/Transform';
import { CanvasManagerProviderGate } from 'features/controlLayers/contexts/CanvasManagerProviderGate';
import { selectDynamicGrid, selectShowHUD } from 'features/controlLayers/store/canvasSettingsSlice';
import { selectCanvasSessionId } from 'features/controlLayers/store/canvasStagingAreaSlice';
import { memo, useCallback, useState } from 'react';
import { PiArrowsLeftRightBold, PiDotsThreeOutlineVerticalFill } from 'react-icons/pi';

import { StagingArea } from './StagingArea';

const MenuContent = memo(() => {
  return (
    <CanvasManagerProviderGate>
      <MenuList>
        <CanvasContextMenuSelectedEntityMenuItems />
        <CanvasContextMenuGlobalMenuItems />
      </MenuList>
    </CanvasManagerProviderGate>
  );
});
MenuContent.displayName = 'MenuContent';

const canvasBgSx = {
  position: 'relative',
  w: 'full',
  h: 'full',
  borderRadius: 'base',
  overflow: 'hidden',
  bg: 'base.900',
  '&[data-dynamic-grid="true"]': {
    bg: 'base.850',
  },
};

const mirroredCanvasLayerSx = {
  position: 'absolute',
  inset: 0,
  transformOrigin: 'center',
  transitionProperty: 'transform',
  transitionDuration: 'normal',
  transitionTimingFunction: 'ease-in-out',
  '&[data-mirrored="true"]': {
    transform: 'scaleX(-1)',
  },
};

const mirroredCanvasBadgeSx = {
  position: 'absolute',
  bottom: 2,
  left: '50%',
  transform: 'translateX(-50%)',
  px: 3,
  py: 1,
  borderRadius: 'full',
  bg: 'base.800',
  color: 'base.100',
  fontSize: 'xs',
  fontWeight: 'semibold',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
};

export const CanvasWorkspacePanel = memo(() => {
  const dynamicGrid = useAppSelector(selectDynamicGrid);
  const showHUD = useAppSelector(selectShowHUD);
  const sessionId = useAppSelector(selectCanvasSessionId);
  const [isMirroredPreview, setIsMirroredPreview] = useState(false);

  const renderMenu = useCallback(() => {
    return <MenuContent />;
  }, []);

  const toggleMirroredPreview = useCallback(() => {
    setIsMirroredPreview((current) => !current);
  }, []);

  const preventPreviewInteraction = useCallback(
    (event: { preventDefault: () => void; stopPropagation: () => void }) => {
      event.preventDefault();
      event.stopPropagation();
    },
    []
  );

  return (
    <StagingAreaContextProvider sessionId={sessionId}>
      <Flex
        borderRadius="base"
        position="relative"
        flexDirection="column"
        height="full"
        width="full"
        gap={2}
        alignItems="center"
        justifyContent="center"
        overflow="hidden"
      >
        <CanvasManagerProviderGate>
          <CanvasToolbar />
        </CanvasManagerProviderGate>
        <Divider />
        <ContextMenu<HTMLDivElement> renderMenu={renderMenu} withLongPress={false}>
          {(ref) => (
            <Flex ref={ref} sx={canvasBgSx} data-dynamic-grid={dynamicGrid}>
              <Flex sx={mirroredCanvasLayerSx} data-mirrored={isMirroredPreview}>
                <InvokeCanvasComponent />
              </Flex>
              {isMirroredPreview && (
                <>
                  <Flex
                    position="absolute"
                    inset={0}
                    cursor="not-allowed"
                    onPointerDown={preventPreviewInteraction}
                    onPointerMove={preventPreviewInteraction}
                    onPointerUp={preventPreviewInteraction}
                    onDoubleClick={preventPreviewInteraction}
                    onWheel={preventPreviewInteraction}
                    onContextMenu={preventPreviewInteraction}
                  />
                  <Box sx={mirroredCanvasBadgeSx}>Mirrored Preview • View Only</Box>
                </>
              )}
              <CanvasManagerProviderGate>
                {!isMirroredPreview && <CanvasTextOverlay />}
                <Flex
                  position="absolute"
                  flexDir="column"
                  top={1}
                  insetInlineStart={1}
                  pointerEvents="none"
                  gap={2}
                  alignItems="flex-start"
                >
                  <PinnedFillColorPickerOverlay />
                  {showHUD && <CanvasHUD />}
                  <CanvasAlertsSaveAllImagesToGallery />
                  <CanvasAlertsSelectedEntityStatus />
                  <CanvasAlertsTextSessionActive />
                  <CanvasAlertsPreserveMask />
                  <CanvasAlertsInvocationProgress />
                  <CanvasAlertsBboxVisibility />
                </Flex>
                <Flex position="absolute" top={1} insetInlineEnd={1} gap={2}>
                  <IconButton
                    aria-label={isMirroredPreview ? 'Disable mirrored preview' : 'Enable mirrored preview'}
                    tooltip={isMirroredPreview ? 'Disable mirrored preview' : 'Enable mirrored preview'}
                    icon={<PiArrowsLeftRightBold />}
                    colorScheme={isMirroredPreview ? 'invokeBlue' : 'base'}
                    onClick={toggleMirroredPreview}
                  />
                  <Menu>
                    <MenuButton as={IconButton} icon={<PiDotsThreeOutlineVerticalFill />} colorScheme="base" />
                    <MenuContent />
                  </Menu>
                </Flex>
                <CanvasBusySpinner position="absolute" insetInlineEnd={2} bottom={2} />
              </CanvasManagerProviderGate>
            </Flex>
          )}
        </ContextMenu>
        <CanvasManagerProviderGate>
          <StagingArea />
        </CanvasManagerProviderGate>
        <Flex position="absolute" bottom={4}>
          <CanvasManagerProviderGate>
            <Filter />
            <Transform />
            <SelectObject />
          </CanvasManagerProviderGate>
        </Flex>
        <CanvasManagerProviderGate>
          <CanvasDropArea />
        </CanvasManagerProviderGate>
      </Flex>
    </StagingAreaContextProvider>
  );
});
CanvasWorkspacePanel.displayName = 'CanvasWorkspacePanel';
