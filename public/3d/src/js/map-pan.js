export function clampMapOffset(offsetY, viewportHeight, contentHeight) {
  const maxOffset = Math.min(0, Number(viewportHeight) - Number(contentHeight));
  const requested = Number.isFinite(Number(offsetY)) ? Number(offsetY) : 0;
  return Math.max(maxOffset, Math.min(0, requested));
}

export function createMapPanController({ viewport, content, image, mapPanel, statusPanel, fitButton, windowRef = window }) {
  if (!viewport || !content || !image || !mapPanel || !statusPanel || !fitButton) {
    throw new TypeError('map pan controller requires viewport, content, image, panels, and fit button');
  }
  let offsetY = 0;
  let viewportHeight = 0;
  let contentHeight = 0;
  let pointer = null;

  function applyOffset(nextOffset) {
    offsetY = clampMapOffset(nextOffset, viewportHeight, contentHeight);
    content.style.setProperty('--map-offset-y', `${offsetY}px`);
    return offsetY;
  }

  function getState() {
    return {
      offsetY,
      minOffsetY: Math.min(0, viewportHeight - contentHeight),
      viewportHeight,
      contentHeight,
      canPan: contentHeight > viewportHeight + 0.5,
    };
  }

  function resize() {
    const naturalWidth = image.naturalWidth || 720;
    const naturalHeight = image.naturalHeight || 1320;
    const contentWidth = Math.max(1, viewport.clientWidth);
    contentHeight = contentWidth * naturalHeight / naturalWidth;
    content.style.height = `${contentHeight}px`;

    const chromeHeight = Math.max(0, mapPanel.offsetHeight - viewport.offsetHeight);
    const panelRect = mapPanel.getBoundingClientRect();
    const statusRect = statusPanel.getBoundingClientRect();
    const horizontalOverlap = panelRect.left < statusRect.right && panelRect.right > statusRect.left;
    const statusBelowMapTop = statusRect.top > panelRect.top;
    const availableHeight = horizontalOverlap && statusBelowMapTop
      ? statusRect.top - panelRect.top - chromeHeight - 1
      : windowRef.innerHeight - panelRect.top - chromeHeight - 10;
    const desiredHeight = Math.max(90, Math.min(contentHeight + 2, availableHeight));
    viewport.style.height = `${desiredHeight}px`;
    viewportHeight = viewport.clientHeight;
    applyOffset(offsetY);
    return getState();
  }

  function fitAll() {
    resize();
    applyOffset(0);
    return getState();
  }

  function focusMarkers() {
    resize();
    const positions = Array.from(content.querySelectorAll('.map-marker'))
      .map(marker => Number.parseFloat(marker.style.top))
      .filter(Number.isFinite);
    if (positions.length) {
      const center = (Math.min(...positions) + Math.max(...positions)) / 200;
      applyOffset(viewportHeight / 2 - center * contentHeight);
    }
    return getState();
  }

  function panBy(deltaY) {
    return applyOffset(offsetY + (Number(deltaY) || 0));
  }

  function finishPointer(event) {
    if (!pointer || event.pointerId !== pointer.id) return;
    pointer = null;
    viewport.classList.remove('is-dragging');
    if (viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  }

  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    resize();
    if (!getState().canPan) return;
    pointer = { id: event.pointerId, startY: event.clientY, startOffsetY: offsetY };
    viewport.classList.add('is-dragging');
    viewport.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    applyOffset(pointer.startOffsetY + event.clientY - pointer.startY);
    event.preventDefault();
  });
  viewport.addEventListener('pointerup', finishPointer);
  viewport.addEventListener('pointercancel', finishPointer);
  viewport.addEventListener('lostpointercapture', finishPointer);
  viewport.addEventListener('wheel', (event) => {
    if (!getState().canPan) return;
    panBy(-event.deltaY);
    event.preventDefault();
  }, { passive: false });
  viewport.addEventListener('keydown', (event) => {
    const delta = event.key === 'ArrowDown' ? -40 : event.key === 'ArrowUp' ? 40 : event.key === 'PageDown' ? -viewportHeight * 0.8 : event.key === 'PageUp' ? viewportHeight * 0.8 : 0;
    if (!delta) return;
    panBy(delta);
    event.preventDefault();
  });
  fitButton.addEventListener('click', fitAll);
  image.addEventListener('load', resize);
  resize();

  return { resize, fitAll, focusMarkers, panBy, getState };
}
