import type { IRDocument } from '@web2figma/ir';

/**
 * Background service worker.
 *
 * Responsibilities:
 * 1. Fetch cross-origin images for canvas rendering.
 * 2. Emulate device metrics & orientation via DevTools Protocol (Emulation.setDeviceMetricsOverride).
 * 3. Relay captures to local relay when requested.
 * 4. Inject capture scripts on demand.
 */

const RELAY = 'http://localhost:3579';

async function fetchImage(url: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  try {
    const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const blob = await response.blob();
    if (blob.size > 12 * 1024 * 1024) return { ok: false, error: 'image too large' };
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < buffer.length; i += chunk) {
      binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
    }
    return { ok: true, dataUrl: `data:${blob.type || 'image/png'};base64,${btoa(binary)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function postToRelay(doc: IRDocument): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const response = await fetch(`${RELAY}/ir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });
    if (!response.ok) return { ok: false, error: `relay HTTP ${response.status}` };
    const body = (await response.json()) as { id: string };
    return { ok: true, id: body.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function setDeviceMetrics(
  tabId: number,
  width: number,
  height: number,
  isMobile: boolean,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      width: Math.round(width),
      height: Math.round(height),
      deviceScaleFactor: 1,
      mobile: isMobile,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function clearDeviceMetrics(tabId: number): Promise<{ ok: boolean }> {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride');
  } catch {
    // Ignore error if already cleared
  }
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Ignore error if already detached
  }
  return { ok: true };
}

/** Inject content scripts on demand. */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: 'ping' })) as {
      ok: boolean;
      hasNative?: boolean;
    };
    if (!res?.hasNative) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['capture.js'] });
      } catch {
        // capture.js may already be present
      }
    }
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['capture.js'] });
    } catch {
      // capture.js may already be present or optional
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: {
      type: string;
      url?: string;
      doc?: IRDocument;
      tabId?: number;
      width?: number;
      height?: number;
      isMobile?: boolean;
    },
    sender,
    sendResponse,
  ) => {
    if (message.type === 'fetch-image' && message.url) {
      void fetchImage(message.url).then(sendResponse);
      return true;
    }
    if (message.type === 'post-relay' && message.doc) {
      void postToRelay(message.doc).then(sendResponse);
      return true;
    }
    if (message.type === 'set-emulation' && message.tabId && message.width && message.height) {
      void setDeviceMetrics(
        message.tabId,
        message.width,
        message.height,
        message.isMobile ?? false,
      ).then(sendResponse);
      return true;
    }
    if (message.type === 'clear-emulation' && message.tabId) {
      void clearDeviceMetrics(message.tabId).then(sendResponse);
      return true;
    }
    if (message.type === 'ensure-scripts' && message.tabId) {
      void ensureContentScript(message.tabId).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === 'ensure-capture-script') {
      const tabId = sender.tab?.id;
      if (tabId) {
        chrome.scripting
          .executeScript({ target: { tabId }, files: ['capture.js'] })
          .then(
            () => sendResponse({ ok: true }),
            () => sendResponse({ ok: false }),
          );
        return true;
      }
      sendResponse({ ok: false });
      return false;
    }
    if (message.type === 'content-ready') {
      sendResponse({ ok: true });
      return false;
    }
    return false;
  },
);

async function dispatch(type: 'capture-page' | 'pick-element'): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await ensureContentScript(tab.id);
  const stored = (await chrome.storage.local.get('options')) as {
    options?: {
      dismissOverlays?: boolean;
      autoLayout?: boolean;
      directPaste?: boolean;
      transport?: string;
    };
  };
  await chrome.tabs.sendMessage(tab.id, { type, ...(stored.options ?? {}), copyHere: true });
}

chrome.commands?.onCommand.addListener((command) => {
  if (command === 'capture-page' || command === 'pick-element') void dispatch(command);
});

export { ensureContentScript, setDeviceMetrics, clearDeviceMetrics };
