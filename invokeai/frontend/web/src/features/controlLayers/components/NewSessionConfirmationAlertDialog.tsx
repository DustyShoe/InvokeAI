import { Checkbox, ConfirmationAlertDialog, Flex, FormControl, FormLabel, Text } from '@invoke-ai/ui-library';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import { useAssertSingleton } from 'common/hooks/useAssertSingleton';
import { buildUseBoolean } from 'common/hooks/useBoolean';
import { canvasSessionReset } from 'features/controlLayers/store/canvasStagingAreaSlice';
import {
  selectSystemShouldConfirmOnNewSession,
  shouldConfirmOnNewSessionToggled,
} from 'features/system/store/systemSlice';
import { useAutoLayoutContextSafe } from 'features/ui/layouts/auto-layout-context';
import { LAUNCHPAD_PANEL_ID } from 'features/ui/layouts/shared';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const [useNewCanvasSessionDialog] = buildUseBoolean(false);

export const useNewCanvasSession = () => {
  const dispatch = useAppDispatch();
  const shouldConfirmOnNewSession = useAppSelector(selectSystemShouldConfirmOnNewSession);
  const newSessionDialog = useNewCanvasSessionDialog();
  const autoLayoutContext = useAutoLayoutContextSafe();

  const newCanvasSessionImmediate = useCallback(() => {
    dispatch(canvasSessionReset());
    // Navigate to the Launchpad after clearing the canvas
    if (autoLayoutContext) {
      autoLayoutContext.focusPanel(LAUNCHPAD_PANEL_ID);
    }
  }, [dispatch, autoLayoutContext]);

  const newCanvasSessionWithDialog = useCallback(() => {
    if (shouldConfirmOnNewSession) {
      newSessionDialog.setTrue();
      return;
    }

    newCanvasSessionImmediate();
  }, [newCanvasSessionImmediate, newSessionDialog, shouldConfirmOnNewSession]);

  return { newCanvasSessionImmediate, newCanvasSessionWithDialog };
};

export const NewCanvasSessionDialog = memo(() => {
  useAssertSingleton('NewCanvasSessionDialog');
  const { t } = useTranslation();

  const dispatch = useAppDispatch();

  const dialog = useNewCanvasSessionDialog();
  const { newCanvasSessionImmediate } = useNewCanvasSession();

  const shouldConfirmOnNewSession = useAppSelector(selectSystemShouldConfirmOnNewSession);
  const onToggleConfirm = useCallback(() => {
    dispatch(shouldConfirmOnNewSessionToggled());
  }, [dispatch]);

  return (
    <ConfirmationAlertDialog
      isOpen={dialog.isTrue}
      onClose={dialog.setFalse}
      title={t('controlLayers.newCanvasSession')}
      acceptCallback={newCanvasSessionImmediate}
      acceptButtonText={t('common.ok')}
      useInert={false}
    >
      <Flex direction="column" gap={3}>
        <Text>{t('controlLayers.newCanvasSessionDesc')}</Text>
        <Text>{t('common.areYouSure')}</Text>
        <FormControl>
          <FormLabel>{t('common.dontAskMeAgain')}</FormLabel>
          <Checkbox isChecked={!shouldConfirmOnNewSession} onChange={onToggleConfirm} />
        </FormControl>
      </Flex>
    </ConfirmationAlertDialog>
  );
});

NewCanvasSessionDialog.displayName = 'NewCanvasSessionDialog';
