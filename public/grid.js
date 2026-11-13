// Pointer glow is decorative and does not change dashboard interactions.
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
if (!motion.matches && window.matchMedia('(pointer: fine)').matches) {
  let pending = false;
  let nextX = 0;
  let nextY = 0;
  document.addEventListener('pointermove', event => {
    nextX = event.clientX;
    nextY = event.clientY;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      document.body.style.setProperty('--pointer-x', `${nextX}px`);
      document.body.style.setProperty('--pointer-y', `${nextY}px`);
      document.body.style.setProperty('--grid-opacity', '1');
      pending = false;
    });
  }, { passive: true });
  document.addEventListener('pointerout', event => {
    if (!event.relatedTarget) document.body.style.setProperty('--grid-opacity', '0');
  });
}
