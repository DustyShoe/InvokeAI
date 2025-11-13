import { MenuItem, Tooltip } from '@invoke-ai/ui-library';
import { useAppSelector } from 'app/store/storeHooks';
import { useCanvasManager } from 'features/controlLayers/contexts/CanvasManagerProviderGate';
import { useEntityIdentifierContext } from 'features/controlLayers/contexts/EntityIdentifierContext';
import { useCanvasIsBusy } from 'features/controlLayers/hooks/useCanvasIsBusy';
import { selectActiveInpaintMaskEntities } from 'features/controlLayers/store/selectors';
import { imageDTOToImageObject } from 'features/controlLayers/store/util';
import {
  canvasToBlob,
  canvasToImageData,
  getRectIntersection,
  getRectUnion,
} from 'features/controlLayers/konva/util';
import type { CanvasEntityAdapter } from 'features/controlLayers/konva/CanvasEntity/types';
import type { CanvasEntityAdapterInpaintMask } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityAdapterInpaintMask';
import type { CanvasEntityAdapterRasterLayer } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityAdapterRasterLayer';
import type { Rect } from 'features/controlLayers/store/types';
import { toast } from 'features/toast/toast';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiSelectionInverseBold } from 'react-icons/pi';
import { uploadImage } from 'services/api/endpoints/images';

const normalizeRect = (rect: Rect): Rect => {
  const x0 = Math.floor(rect.x);
  const y0 = Math.floor(rect.y);
  const x1 = Math.ceil(rect.x + rect.width);
  const y1 = Math.ceil(rect.y + rect.height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
};

const getAdapterStageRect = (adapter: CanvasEntityAdapter): Rect | null => {
  const pixelRect = adapter.transformer.$pixelRect.get();
  if (pixelRect.width <= 0 || pixelRect.height <= 0) {
    return null;
  }
  const { x, y } = adapter.state.position;
  const rect = {
    x: x + pixelRect.x,
    y: y + pixelRect.y,
    width: pixelRect.width,
    height: pixelRect.height,
  };
  return normalizeRect(rect);
};

export const RasterLayerMenuItemsExtractMaskedArea = () => {
  const { t } = useTranslation();
  const canvasManager = useCanvasManager();
  const entityIdentifier = useEntityIdentifierContext('raster_layer');
  const isBusy = useCanvasIsBusy();
  const [isProcessing, setIsProcessing] = useState(false);

  const hasVisibleMask = useAppSelector((state) => {
    const masks = selectActiveInpaintMaskEntities(state.canvas.present);
    return masks.length > 0;
  });

  const tooltip = useMemo(() => {
    if (!hasVisibleMask) {
      return t('controlLayers.extractMaskedAreaTooltipNoMask');
    }
    return undefined;
  }, [hasVisibleMask, t]);

  const onClick = useCallback(async () => {
    setIsProcessing(true);
    try {
      const adapter = canvasManager.getAdapter(entityIdentifier);
      if (!adapter || adapter.state.type !== 'raster_layer') {
        throw new Error('Active raster layer adapter not found');
      }

      const rasterAdapter = adapter as CanvasEntityAdapterRasterLayer;
      const rasterRect = getAdapterStageRect(rasterAdapter);

      if (!rasterRect || rasterRect.width === 0 || rasterRect.height === 0) {
        toast({
          id: 'EXTRACT_MASKED_AREA_NO_CONTENT',
          title: t('controlLayers.extractMaskedAreaNoOverlap'),
          status: 'info',
        });
        return;
      }

      const maskAdapters = canvasManager.compositor.getVisibleAdaptersOfType('inpaint_mask');

      const overlappingMasks = maskAdapters.filter((maskAdapter) => {
        const maskRect = getAdapterStageRect(maskAdapter);
        if (!maskRect) {
          return false;
        }
        const intersection = getRectIntersection(rasterRect, maskRect);
        return intersection.width > 0 && intersection.height > 0;
      }) as CanvasEntityAdapterInpaintMask[];

      if (overlappingMasks.length === 0) {
        toast({
          id: 'EXTRACT_MASKED_AREA_NO_OVERLAP',
          title: t('controlLayers.extractMaskedAreaNoOverlap'),
          status: 'info',
        });
        return;
      }

      const intersectionRects = overlappingMasks
        .map((maskAdapter) => {
          const maskRect = getAdapterStageRect(maskAdapter);
          if (!maskRect) {
            return null;
          }
          const intersection = getRectIntersection(rasterRect, maskRect);
          if (intersection.width <= 0 || intersection.height <= 0) {
            return null;
          }
          return normalizeRect(intersection);
        })
        .filter((rect): rect is Rect => Boolean(rect));

      if (intersectionRects.length === 0) {
        toast({
          id: 'EXTRACT_MASKED_AREA_NO_OVERLAP',
          title: t('controlLayers.extractMaskedAreaNoOverlap'),
          status: 'info',
        });
        return;
      }

      const extractionRect = intersectionRects.reduce((acc, rect) => getRectUnion(acc, rect));
      const rect = normalizeRect(extractionRect);

      if (rect.width === 0 || rect.height === 0) {
        toast({
          id: 'EXTRACT_MASKED_AREA_NO_OVERLAP',
          title: t('controlLayers.extractMaskedAreaNoOverlap'),
          status: 'info',
        });
        return;
      }

      const rasterCanvas = rasterAdapter.getCanvas(rect);
      const maskCanvas = canvasManager.compositor.getCompositeCanvas(overlappingMasks, rect);

      const rasterImageData = canvasToImageData(rasterCanvas);
      const maskImageData = canvasToImageData(maskCanvas);

      const extractedCanvas = document.createElement('canvas');
      extractedCanvas.width = rect.width;
      extractedCanvas.height = rect.height;
      const extractedCtx = extractedCanvas.getContext('2d');

      if (!extractedCtx) {
        throw new Error('Failed to get canvas context');
      }

      extractedCtx.imageSmoothingEnabled = false;
      const outputImageData = extractedCtx.createImageData(rect.width, rect.height);

      const src = rasterImageData.data;
      const mask = maskImageData.data;
      const dest = outputImageData.data;

      let hasMaskedPixels = false;

      for (let i = 0; i < dest.length; i += 4) {
        const maskAlpha = mask[i + 3] ?? 0;
        if (maskAlpha === 0) {
          continue;
        }
        const srcAlpha = src[i + 3] ?? 0;
        const alpha = Math.round((srcAlpha * maskAlpha) / 255);
        if (alpha === 0) {
          continue;
        }
        dest[i] = src[i];
        dest[i + 1] = src[i + 1];
        dest[i + 2] = src[i + 2];
        dest[i + 3] = alpha;
        hasMaskedPixels = true;
      }

      if (!hasMaskedPixels) {
        toast({
          id: 'EXTRACT_MASKED_AREA_NO_OVERLAP',
          title: t('controlLayers.extractMaskedAreaNoOverlap'),
          status: 'info',
        });
        return;
      }

      extractedCtx.putImageData(outputImageData, 0, 0);

      const blob = await canvasToBlob(extractedCanvas);
      const file = new File([blob], `extracted-layer-${Date.now()}.png`, { type: 'image/png' });
      const imageDTO = await uploadImage({
        file,
        image_category: 'general',
        is_intermediate: true,
        silent: true,
      });

      const imageObject = imageDTOToImageObject(imageDTO);
      const layerName = rasterAdapter.state.name ?? t('controlLayers.rasterLayer');
      const name = t('controlLayers.extractedLayerName', { layerName });

      canvasManager.stateApi.addRasterLayer({
        overrides: {
          name,
          objects: [imageObject],
          position: { x: Math.round(rect.x), y: Math.round(rect.y) },
        },
        isSelected: true,
        addAfter: entityIdentifier.id,
      });

      toast({
        id: 'EXTRACT_MASKED_AREA_SUCCESS',
        title: t('controlLayers.extractMaskedAreaSuccess'),
        status: 'success',
      });
    } catch (error) {
      toast({
        id: 'EXTRACT_MASKED_AREA_ERROR',
        title: t('controlLayers.extractMaskedAreaError'),
        description: error instanceof Error ? error.message : String(error),
        status: 'error',
      });
    } finally {
      setIsProcessing(false);
    }
  }, [canvasManager, entityIdentifier, t]);

  return (
    <Tooltip label={tooltip} shouldWrapChildren isDisabled={!tooltip}>
      <MenuItem
        icon={<PiSelectionInverseBold />}
        onClick={onClick}
        isDisabled={isBusy || isProcessing || !hasVisibleMask}
      >
        {t('controlLayers.extractMaskedAreaToNewLayer')}
      </MenuItem>
    </Tooltip>
  );
};

RasterLayerMenuItemsExtractMaskedArea.displayName = 'RasterLayerMenuItemsExtractMaskedArea';
