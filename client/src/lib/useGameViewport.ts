import { useEffect } from 'react';

/**
 * Pins the game screen to the *visual* viewport (CSS vars --app-height/--app-top),
 * so when the on-screen keyboard opens the layout shrinks and the guess input
 * stays visible instead of being covered or scrolling the page. Also locks page
 * scrolling/overscroll while the game screen is mounted.
 */
export function useGameViewport(): void {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    const update = () => {
      root.style.setProperty('--app-height', `${vv ? vv.height : window.innerHeight}px`);
      root.style.setProperty('--app-top', `${vv ? vv.offsetTop : 0}px`);
    };
    update();
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    document.body.classList.add('game-active');
    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.body.classList.remove('game-active');
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-top');
    };
  }, []);
}
