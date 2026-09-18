import { captureDocument } from '@web2figma/capture';

/**
 * The bundle injected into a Playwright page. It exposes exactly one function,
 * so the relay can capture a rendered page with the same code path the
 * extension uses in a live tab.
 */

declare global {
  interface Window {
    __web2figma?: {
      capture: (options?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

window.__web2figma = {
  capture: async (options = {}) => {
    const { doc } = await captureDocument(document.documentElement, {
      dismissOverlays: true,
      // Playwright already waited for the network and fonts; a second scroll
      // pass here would only slow the render.
      scrollDelay: 60,
      ...options,
    });
    return doc;
  },
};

export {};
