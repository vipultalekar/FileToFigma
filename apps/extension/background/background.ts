import type { IRDocument } from '@web2figma/ir';

/**
 * Background service worker (PRD section 5 and 6).
 *
 * Two jobs only: fetch cross-origin images with the host permissions the page
 * lacks, and post captures to the local relay. Everything else lives in the
 * content script.
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

chrome.runtime.onMessage.addListener((message: { type: string; url?: string; doc?: IRDocument }, _sender, sendResponse) => {
  if (message.type === 'fetch-image' && message.url) {
    void fetchImage(message.url).then(sendResponse);
    return true;
  }
  if (message.type === 'post-relay' && message.doc) {
    void postToRelay(message.doc).then(sendResponse);
    return true;
  }
  if (message.type === 'content-ready') {
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

/** Inject the content script on demand: MV3 activeTab, no always-on scripting. */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }
}

async function dispatch(type: 'capture-page' | 'pick-element'): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await ensureContentScript(tab.id);
  // A keyboard shortcut leaves focus in the page, which is the one case where
  // the page itself can reach the clipboard. Stored options are reused so the
  // shortcut behaves like the last popup run.
  const stored = (await chrome.storage.local.get('options')) as {
    options?: { dismissOverlays: boolean; autoLayout: boolean; transport: string };
  };
  await chrome.tabs.sendMessage(tab.id, { type, ...(stored.options ?? {}), copyHere: true });
}

chrome.commands?.onCommand.addListener((command) => {
  if (command === 'capture-page' || command === 'pick-element') void dispatch(command);
});

export { ensureContentScript };
