import { IconButton, Tooltip } from '@invoke-ai/ui-library';
import { useAppDispatch } from 'app/store/storeHooks';
import { workflowModeChanged } from 'features/nodes/store/workflowLibrarySlice';
import { useAutoLayoutContext } from 'features/ui/layouts/auto-layout-context';
import { WORKSPACE_PANEL_ID } from 'features/ui/layouts/shared';
import { useLoadWorkflowWithDialog } from 'features/workflowLibrary/components/LoadWorkflowConfirmationAlertDialog';
import type { MouseEvent } from 'react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PiPencilBold } from 'react-icons/pi';

export const EditWorkflow = ({ workflowId }: { workflowId: string }) => {
  const dispatch = useAppDispatch();
  const loadWorkflowWithDialog = useLoadWorkflowWithDialog();
  const { t } = useTranslation();
  const { focusPanel } = useAutoLayoutContext();

  const handleClickEdit = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      loadWorkflowWithDialog({
        type: 'library',
        data: workflowId,
        onSuccess: () => {
          dispatch(workflowModeChanged('edit'));
          focusPanel(WORKSPACE_PANEL_ID);
        },
      });
    },
    [dispatch, focusPanel, loadWorkflowWithDialog, workflowId]
  );

  return (
    <Tooltip label={t('workflows.edit')} closeOnScroll>
      <IconButton
        size="sm"
        variant="link"
        alignSelf="stretch"
        aria-label={t('workflows.edit')}
        onClick={handleClickEdit}
        icon={<PiPencilBold />}
      />
    </Tooltip>
  );
};
