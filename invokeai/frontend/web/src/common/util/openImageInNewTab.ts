type ViewerTransform = {
  scale: number;
  x: number;
  y: number;
};

export const MIN_VIEWER_SCALE = 0.1;
export const MAX_VIEWER_SCALE = 20;

export const INITIAL_VIEWER_TRANSFORM: ViewerTransform = { scale: 1, x: 0, y: 0 };

type Point = { x: number; y: number };

export const calculateWheelZoom = (
  current: ViewerTransform,
  wheelDeltaPixels: number,
  pointerFromViewportCenter: Point
): ViewerTransform => {
  const unclampedScale = current.scale * Math.exp(-wheelDeltaPixels * 0.0015);
  const scale = Math.min(MAX_VIEWER_SCALE, Math.max(MIN_VIEWER_SCALE, unclampedScale));
  const ratio = scale / current.scale;

  return {
    scale,
    x: pointerFromViewportCenter.x - ratio * (pointerFromViewportCenter.x - current.x),
    y: pointerFromViewportCenter.y - ratio * (pointerFromViewportCenter.y - current.y),
  };
};

const initializeImageViewer = (viewerWindow: Window, imageUrl: string) => {
  viewerWindow.opener = null;

  const { document } = viewerWindow;
  document.title = imageUrl.split('/').at(-1)?.split('?')[0] || 'Image';

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #111; }
    #viewport { position: relative; width: 100%; height: 100%; overflow: hidden; cursor: grab; touch-action: none; }
    #image-position { position: absolute; left: 50%; top: 50%; pointer-events: none; }
    #image { display: block; max-width: 100vw; max-height: 100vh; transform-origin: center; user-select: none; }
    #scale { position: absolute; top: 12px; right: 12px; padding: 4px 8px; border-radius: 4px; background: rgba(0, 0, 0, .65); color: #eee; font: 13px system-ui, sans-serif; font-variant-numeric: tabular-nums; pointer-events: none; }
  `;

  const viewport = document.createElement('div');
  viewport.id = 'viewport';
  const imagePosition = document.createElement('div');
  imagePosition.id = 'image-position';
  const image = document.createElement('img');
  image.id = 'image';
  image.alt = '';
  image.draggable = false;
  image.src = imageUrl;
  const scaleIndicator = document.createElement('div');
  scaleIndicator.id = 'scale';

  imagePosition.append(image);
  viewport.append(imagePosition, scaleIndicator);
  document.head.append(style);
  document.body.replaceChildren(viewport);

  let transform = INITIAL_VIEWER_TRANSFORM;
  let isDragging = false;
  let lastPointer = { x: 0, y: 0 };

  const render = () => {
    imagePosition.style.transform = `translate(${transform.x}px, ${transform.y}px)`;
    image.style.transform = `translate(-50%, -50%) scale(${transform.scale})`;
    scaleIndicator.textContent = `${Math.round(transform.scale * 100)}%`;
  };

  viewport.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const deltaMultiplier =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? rect.height
            : 1;
      transform = calculateWheelZoom(transform, event.deltaY * deltaMultiplier, {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      });
      imagePosition.style.transition = 'transform 80ms ease-out';
      image.style.transition = 'transform 80ms ease-out';
      render();
    },
    { passive: false }
  );

  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    viewport.setPointerCapture(event.pointerId);
    viewport.style.cursor = 'grabbing';
    imagePosition.style.transition = 'none';
    image.style.transition = 'none';
    lastPointer = { x: event.clientX, y: event.clientY };
    isDragging = true;
  });

  viewport.addEventListener('pointermove', (event) => {
    if (!isDragging) {
      return;
    }
    transform = {
      ...transform,
      x: transform.x + event.clientX - lastPointer.x,
      y: transform.y + event.clientY - lastPointer.y,
    };
    lastPointer = { x: event.clientX, y: event.clientY };
    render();
  });

  const finishDragging = () => {
    viewport.style.cursor = 'grab';
    isDragging = false;
  };
  viewport.addEventListener('pointerup', finishDragging);
  viewport.addEventListener('pointercancel', finishDragging);
  viewport.addEventListener('dblclick', () => {
    transform = INITIAL_VIEWER_TRANSFORM;
    imagePosition.style.transition = 'transform 80ms ease-out';
    image.style.transition = 'transform 80ms ease-out';
    render();
  });

  render();
  document.close();
};

export const openImageInNewTab = (imageUrl: string) => {
  const viewerWindow = window.open('');
  if (!viewerWindow) {
    return;
  }
  initializeImageViewer(viewerWindow, imageUrl);
};
