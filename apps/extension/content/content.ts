import type { IRDocument } from '@web2figma/ir';
import { captureDocument, startPicker } from '@web2figma/capture';
import { encodePayload } from '@web2figma/shared';
import { transformDocument } from '@web2figma/transform';

/**
 * Content script (PRD section 5 and 6).
 *
 * Runs capture in the page's own world so authenticated sessions, applied CSS
 * and rendered geometry are all the real thing. Images that taint the canvas
 * are fetched through the background script, which holds the host permissions
 * the page does not.
 */

type Request =
  | { type: 'capture-page'; dismissOverlays?: boolean; autoLayout?: boolean; transport?: 'clipboard' | 'relay' }
  | { type: 'pick-element'; dismissOverlays?: boolean; autoLayout?: boolean; transport?: 'clipboard' | 'relay' }
  | { type: 'ping' };

interface CaptureOutcome {
  ok: boolean;
  nodes?: number;
  bytes?: number;
  transport?: string;
  error?: string;
}

const fetchViaBackground = async (url: string): Promise<string | null> => {
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'fetch-image', url })) as {
      ok: boolean;
      dataUrl?: string;
    };
    return response?.ok ? (response.dataUrl ?? null) : null;
  } catch {
    return null;
  }
};

function toast(message: string, tone: 'info' | 'error' = 'info'): void {
  const el = document.createElement('div');
  el.textContent = message;
  el.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:24px',
    'transform:translateX(-50%)',
    'z-index:2147483647',
    `background:${tone === 'error' ? '#b91c1c' : '#111827'}`,
    'color:#fff',
    'padding:10px 14px',
    'border-radius:8px',
    'font:13px/1.4 system-ui,sans-serif',
    'box-shadow:0 8px 24px rgba(0,0,0,0.25)',
  ].join(';');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function deliver(
  doc: IRDocument,
  transport: 'clipboard' | 'relay',
): Promise<CaptureOutcome> {
  const payload = await encodePayload(doc);

  if (transport === 'relay') {
    const response = (await chrome.runtime.sendMessage({
      type: 'post-relay',
      doc,
    })) as { ok: boolean; error?: string };
    if (response?.ok) {
      toast('Sent to the local relay. Open the Figma plugin and press Latest capture.');
      return { ok: true, bytes: payload.length, transport: 'relay' };
    }
    toast(`Relay unavailable (${response?.error ?? 'no response'}), copying instead`, 'error');
  }

  try {
    await navigator.clipboard.writeText(payload);
    toast('Copied. Paste it into the Web2Figma plugin.');
    return { ok: true, bytes: payload.length, transport: 'clipboard' };
  } catch (err) {
    // Clipboard writes need a user gesture and a focused document; fall back to
    // a textarea the user can copy from rather than losing the capture.
    const area = document.createElement('textarea');
    area.value = payload;
    area.style.cssText =
      'position:fixed;left:8px;bottom:8px;width:320px;height:120px;z-index:2147483647;';
    document.body.appendChild(area);
    area.select();
    toast('Could not write to the clipboard. Copy the text box that just appeared.', 'error');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runCapture(
  root: Element,
  options: { dismissOverlays?: boolean; autoLayout?: boolean; transport?: 'clipboard' | 'relay' },
): Promise<CaptureOutcome> {
  toast('Capturing...');
  const { doc: raw, elapsedMs } = await captureDocument(root, {
    dismissOverlays: options.dismissOverlays ?? true,
    fetchViaBackground,
  });
  const { doc, stats } = transformDocument(raw, {
    disableAutoLayout: options.autoLayout === false,
  });
  const coverage =
    stats.layout.frames === 0
      ? 0
      : Math.round((stats.layout.withLayout / stats.layout.frames) * 100);
  const result = await deliver(doc, options.transport ?? 'clipboard');
  toast(
    `${stats.nodesOut} nodes, ${coverage}% auto layout, ${(elapsedMs / 1000).toFixed(1)}s capture`,
  );
  return { ...result, nodes: stats.nodesOut };
}

chrome.runtime.onMessage.addListener((request: Request, _sender, sendResponse) => {
  if (request.type === 'ping') {
    sendResponse({ ok: true });
    return false;
  }

  if (request.type === 'capture-page') {
    void runCapture(document.documentElement, request).then(sendResponse, (err: unknown) =>
      sendResponse({ ok: false, error: String(err) }),
    );
    return true;
  }

  if (request.type === 'pick-element') {
    startPicker({
      onPick: (elements) => {
        const target = elements[0];
        if (!target) return;
        if (elements.length > 1) {
          toast(`Capturing ${elements.length} elements`);
        }
        void runCapture(target, request);
      },
      onCancel: () => toast('Picker cancelled'),
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// Announce readiness so the popup can tell an injected tab from a stale one.
void chrome.runtime.sendMessage({ type: 'content-ready', href: location.href }).catch(() => undefined);
