/**
 * Pre-capture page preparation (PRD section 5).
 *
 * Skipping any of these is the single biggest cause of bad output, so they run
 * in order and every removal is reported. All DOM writes happen here, strictly
 * before the measurement pass, so the walk never causes layout thrashing.
 */

export interface PrepareOptions {
  /** Remove cookie banners and modal overlays. */
  dismissOverlays?: boolean;
  /** Milliseconds to wait after each scroll step. */
  scrollDelay?: number;
  /** Cap on image decode waits. */
  decodeTimeout?: number;
  doc?: Document;
  /** Skip the full page scroll (e.g. for element picking or static iframes). */
  skipScroll?: boolean;
}

export interface PrepareResult {
  removedOverlays: string[];
  documentHeight: number;
  fontsReady: boolean;
  imagesDecoded: number;
  imagesTimedOut: number;
  cleanup: () => void;
}

/** Maintained selector list for the usual cookie/consent/modal furniture. */
export const OVERLAY_SELECTORS = [
  '#onetrust-consent-sdk',
  '#onetrust-banner-sdk',
  '.ot-sdk-container',
  '#CybotCookiebotDialog',
  '#cookie-banner',
  '#cookieConsent',
  '.cookie-consent',
  '.cookie-banner',
  '.cookie-notice',
  '[id*="cookie-consent"]',
  '[class*="cookie-consent"]',
  '[aria-label*="cookie" i][role="dialog"]',
  '#usercentrics-root',
  '.osano-cm-window',
  '.cc-window',
  '.gdpr-banner',
  '[data-testid="cookie-policy-manage-dialog"]',
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function preparePage(options: PrepareOptions = {}): Promise<PrepareResult> {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;
  const removed: string[] = [];
  const cleanups: (() => void)[] = [];

  // 1. Scroll the full height to trigger lazy loading and IntersectionObserver.
  const originalScroll = win.scrollY;
  if (!options.skipScroll) {
    const stepDelay = options.scrollDelay ?? 120;
    const viewportHeight = win.innerHeight || 800;
    const fullHeight = doc.documentElement.scrollHeight;
    for (let y = 0; y < fullHeight; y += viewportHeight) {
      win.scrollTo(0, y);
      await sleep(stepDelay);
    }
    win.scrollTo(0, 0);
    await sleep(stepDelay);
  }

  // 2. Fonts.
  let fontsReady = false;
  try {
    await doc.fonts.ready;
    fontsReady = true;
  } catch {
    fontsReady = false;
  }

  // 3. Image decoding, with a per-image timeout so one dead CDN cannot stall
  //    the whole capture.
  const images = [...doc.querySelectorAll('img')];
  let decoded = 0;
  let timedOut = 0;
  await Promise.all(
    images.map(async (img) => {
      try {
        await Promise.race([
          img.decode(),
          sleep(options.decodeTimeout ?? 3000).then(() => {
            throw new Error('decode timeout');
          }),
        ]);
        decoded++;
      } catch {
        timedOut++;
      }
    }),
  );

  // 4. Freeze animations and transitions so the capture is a still frame.
  const freeze = doc.createElement('style');
  freeze.setAttribute('data-web2figma', 'freeze');
  freeze.textContent =
    '*, *::before, *::after { animation-play-state: paused !important; transition: none !important; scroll-behavior: auto !important; }';
  doc.head.appendChild(freeze);
  cleanups.push(() => freeze.remove());

  // 5. Overlays, opt-in.
  if (options.dismissOverlays) {
    for (const selector of OVERLAY_SELECTORS) {
      for (const el of doc.querySelectorAll<HTMLElement>(selector)) {
        const previous = el.style.display;
        el.style.display = 'none';
        removed.push(selector);
        cleanups.push(() => {
          el.style.display = previous;
        });
      }
    }
    // Scroll locks travel with modals and leave the page unscrollable.
    const body = doc.body;
    const bodyOverflow = body.style.overflow;
    if (win.getComputedStyle(body).overflow === 'hidden') {
      body.style.overflow = 'visible';
      cleanups.push(() => {
        body.style.overflow = bodyOverflow;
      });
    }
  }

  // 6. Record the true document height after everything has settled.
  const documentHeight = doc.documentElement.scrollHeight;

  return {
    removedOverlays: removed,
    documentHeight,
    fontsReady,
    imagesDecoded: decoded,
    imagesTimedOut: timedOut,
    cleanup: () => {
      for (const c of cleanups) c();
      if (!options.skipScroll) {
        win.scrollTo(0, originalScroll);
      }
    },
  };
}
