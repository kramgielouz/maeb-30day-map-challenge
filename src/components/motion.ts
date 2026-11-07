/** True when the visitor asked the OS for less motion. Read at call time, never cached. */
export const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
