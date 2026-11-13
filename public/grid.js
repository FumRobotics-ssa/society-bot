// The illuminated line grid eases toward the pointer without changing UI behavior.
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
if (!motion.matches && window.matchMedia('(pointer: fine)').matches) {
  let currentX = window.innerWidth / 2;
  let currentY = window.innerHeight / 2;
  let targetX = currentX;
  let targetY = currentY;
  let frame = 0;

  function followPointer() {
    currentX += (targetX - currentX) * 0.14;
    currentY += (targetY - currentY) * 0.14;
    document.body.style.setProperty('--pointer-x', `${currentX}px`);
    document.body.style.setProperty('--pointer-y', `${currentY}px`);
    if (Math.abs(targetX - currentX) + Math.abs(targetY - currentY) > 0.6) {
      frame = requestAnimationFrame(followPointer);
    } else {
      frame = 0;
    }
  }

  document.addEventListener('pointermove', event => {
    targetX = event.clientX;
    targetY = event.clientY;
    document.body.style.setProperty('--grid-opacity', '.65');
    if (!frame) frame = requestAnimationFrame(followPointer);
  }, { passive: true });

  document.addEventListener('pointerout', event => {
    if (!event.relatedTarget) document.body.style.setProperty('--grid-opacity', '0');
  });
}
