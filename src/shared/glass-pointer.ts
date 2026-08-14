const GLASS_SELECTOR = "[data-glass-reactive]";

export function useGlassPointer(root: Document | HTMLElement = document) {
  const precisePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const surfaceRoot = root instanceof Document ? root.querySelector<HTMLElement>(GLASS_SELECTOR) : root;

  let activeSurface: HTMLElement | null = null;
  let pendingSurface: HTMLElement | null = null;
  let pendingX = 0;
  let pendingY = 0;
  let frame = 0;

  function isInsideRoot(target: EventTarget | null) {
    return Boolean(surfaceRoot && target instanceof Node && surfaceRoot.contains(target));
  }

  function clearActiveSurface() {
    activeSurface?.classList.remove("is-glass-active");
    activeSurface = null;
  }

  function renderPointer() {
    frame = 0;
    const surface = pendingSurface;

    if (!surface || !surface.isConnected) {
      clearActiveSurface();
      return;
    }

    if (activeSurface !== surface) {
      clearActiveSurface();
      activeSurface = surface;
      activeSurface.classList.add("is-glass-active");
    }

    const bounds = surface.getBoundingClientRect();
    if (!bounds.width || !bounds.height) {
      return;
    }

    const x = Math.min(1, Math.max(0, (pendingX - bounds.left) / bounds.width));
    const y = Math.min(1, Math.max(0, (pendingY - bounds.top) / bounds.height));
    surface.style.setProperty("--glass-x", `${(x * 100).toFixed(2)}%`);
    surface.style.setProperty("--glass-y", `${(y * 100).toFixed(2)}%`);
    surface.style.setProperty("--glass-shift-x", `${((x - 0.5) * 2.4).toFixed(2)}px`);
    surface.style.setProperty("--glass-shift-y", `${((y - 0.5) * 1.6).toFixed(2)}px`);
  }

  function handlePointerMove(event: PointerEvent) {
    if (
      !precisePointer.matches ||
      reducedMotion.matches ||
      document.documentElement.dataset.visualMotion === "reduced" ||
      event.pointerType === "touch"
    ) {
      return;
    }

    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(GLASS_SELECTOR) : null;
    if (!target || !isInsideRoot(target)) {
      pendingSurface = null;
      clearActiveSurface();
      return;
    }

    pendingSurface = target;
    pendingX = event.clientX;
    pendingY = event.clientY;

    if (!frame) {
      frame = window.requestAnimationFrame(renderPointer);
    }
  }

  function handlePointerOut(event: PointerEvent) {
    if (!isInsideRoot(event.relatedTarget)) {
      pendingSurface = null;
      clearActiveSurface();
    }
  }

  function handleMotionPreferenceChange() {
    if (
      reducedMotion.matches ||
      document.documentElement.dataset.visualMotion === "reduced" ||
      !precisePointer.matches
    ) {
      pendingSurface = null;
      clearActiveSurface();
    }
  }

  root.addEventListener("pointermove", handlePointerMove as EventListener, { passive: true });
  root.addEventListener("pointerout", handlePointerOut as EventListener, { passive: true });
  reducedMotion.addEventListener("change", handleMotionPreferenceChange);
  precisePointer.addEventListener("change", handleMotionPreferenceChange);

  return () => {
    root.removeEventListener("pointermove", handlePointerMove as EventListener);
    root.removeEventListener("pointerout", handlePointerOut as EventListener);
    reducedMotion.removeEventListener("change", handleMotionPreferenceChange);
    precisePointer.removeEventListener("change", handleMotionPreferenceChange);
    if (frame) {
      window.cancelAnimationFrame(frame);
    }
    clearActiveSurface();
  };
}
