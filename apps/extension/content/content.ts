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

interface CaptureRequest {
  dismissOverlays?: boolean;
  autoLayout?: boolean;
  transport?: 'clipboard' | 'relay';
  /** Set by the background worker: no popup is open, so the page copies. */
  copyHere?: boolean;
}

type Request =
  | ({ type: 'capture-page' } & CaptureRequest)
  | ({ type: 'pick-element' } & CaptureRequest)
  | { type: 'ping' };

interface CaptureOutcome {
  ok: boolean;
  nodes?: number;
  bytes?: number;
  transport?: string;
  error?: string;
  /** Returned when the caller (the popup) will do the clipboard write itself. */
  payload?: string;
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

/**
 * Copy from inside the page.
 *
 * navigator.clipboard.writeText refuses to run while the document is not
 * focused, which is exactly the case when the extension popup is open: the
 * popup holds focus, not the page. So this path is only used when the capture
 * was started from a keyboard shortcut, where the page really is focused; the
 * popup copies the payload itself.
 */
async function copyFromPage(payload: string): Promise<{ ok: boolean; error?: string }> {
  if (document.hasFocus()) {
    try {
      await navigator.clipboard.writeText(payload);
      return { ok: true };
    } catch {
      // Fall through to the legacy path below.
    }
  }

  // execCommand still works from a focused textarea in an unfocused document in
  // some Chrome versions, and costs nothing to try.
  const area = document.createElement('textarea');
  area.value = payload;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  if (copied) return { ok: true };
  return { ok: false, error: 'the page could not write to the clipboard' };
}

/**
 * Chrome's extension messaging tops out well below the size of a heavy page's
 * capture, and the failure is an opaque rejection rather than a useful error.
 * Anything approaching the limit goes to the relay instead.
 */
const MESSAGE_LIMIT = 30 * 1024 * 1024;

async function deliver(
  doc: IRDocument,
  transport: 'clipboard' | 'relay',
  copyHere: boolean,
): Promise<CaptureOutcome> {
  const payload = await encodePayload(doc);
  const tooBigToMessage = !copyHere && payload.length > MESSAGE_LIMIT;

  if (transport === 'relay' || tooBigToMessage) {
    const response = (await chrome.runtime.sendMessage({
      type: 'post-relay',
      doc,
    })) as { ok: boolean; error?: string };
    if (response?.ok) {
      toast('Sent to the local relay. Open the Figma plugin and press Latest capture.');
      return { ok: true, bytes: payload.length, transport: 'relay' };
    }
    if (tooBigToMessage) {
      const mb = (payload.length / 1024 / 1024).toFixed(0);
      toast(
        `This capture is ${mb}MB, too large for the clipboard. Start the local relay and try again.`,
        'error',
      );
      return {
        ok: false,
        bytes: payload.length,
        error: `capture is ${mb}MB; run the local relay (pnpm relay) and tick "Send to local relay"`,
      };
    }
    toast(`Relay unavailable (${response?.error ?? 'no response'}), copying instead`, 'error');
  }

  // Started from the popup: hand the payload back and let the popup, which is
  // the focused document, do the clipboard write.
  if (!copyHere) {
    return { ok: true, bytes: payload.length, transport: 'clipboard', payload };
  }

  const copy = await copyFromPage(payload);
  if (copy.ok) {
    toast('Copied. Paste it into the Web2Figma plugin.');
    return { ok: true, bytes: payload.length, transport: 'clipboard' };
  }

  // Last resort: show the payload so the capture is not lost.
  const area = document.createElement('textarea');
  area.value = payload;
  area.style.cssText =
    'position:fixed;left:8px;bottom:8px;width:320px;height:120px;z-index:2147483647;';
  document.body.appendChild(area);
  area.focus();
  area.select();
  toast('Could not reach the clipboard. Press Ctrl+C to copy the box that appeared.', 'error');
  return { ok: false, bytes: payload.length, error: copy.error ?? 'clipboard unavailable' };
}

async function runCapture(
  root: Element,
  options: {
    dismissOverlays?: boolean;
    autoLayout?: boolean;
    transport?: 'clipboard' | 'relay';
    /** True when no popup is open, so the page itself must do the copy. */
    copyHere?: boolean;
  },
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
  const result = await deliver(doc, options.transport ?? 'clipboard', options.copyHere ?? false);
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
        // By the time an element is picked the popup has closed, so the page
        // is focused and can reach the clipboard itself.
        void runCapture(target, { ...request, copyHere: true });
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
