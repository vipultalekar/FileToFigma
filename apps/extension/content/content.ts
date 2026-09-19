import type { IRDocument } from '@web2figma/ir';
import { captureDocument, startPicker } from '@web2figma/capture';
import { encodePayload } from '@web2figma/shared';
import { transformDocument } from '@web2figma/transform';
import { createFigmaH2DClipboardHtml } from './figma-h2d';

/**
 * Content script.
 *
 * Runs capture in the page's context. Supports both:
 * 1. Direct Figma Canvas Paste (Figma native H2D format for Ctrl+V)
 * 2. Web2Figma IR / Relay format
 */

interface CaptureRequest {
  dismissOverlays?: boolean;
  autoLayout?: boolean;
  transport?: 'clipboard' | 'relay';
  directPaste?: boolean;
  scope?: 'full' | 'viewport';
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
  payload?: string;
  directPaste?: boolean;
  htmlPayload?: string;
  textPayload?: string;
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
    'padding:10px 16px',
    'border-radius:8px',
    'font:13px/1.4 system-ui,sans-serif',
    'box-shadow:0 8px 24px rgba(0,0,0,0.25)',
    'pointer-events:none',
    'transition:opacity 0.3s',
  ].join(';');
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

/**
 * Copy directly from page context when focused.
 */
async function copyH2DFromPage(htmlPayload: string, textPayload: string): Promise<boolean> {
  // 1. Try modern Async Clipboard API
  try {
    window.focus();
    const item = new ClipboardItem({
      'text/html': new Blob([htmlPayload], { type: 'text/html' }),
      'text/plain': new Blob([textPayload], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
    return true;
  } catch (err) {
    console.warn('Async clipboard write failed, trying fallback copy:', err);
  }

  // 2. Fallback via document.execCommand('copy') with copy event listener
  try {
    let success = false;
    const listener = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData?.clearData();
      e.clipboardData?.setData('text/html', htmlPayload);
      e.clipboardData?.setData('text/plain', textPayload);
      success = true;
    };
    document.addEventListener('copy', listener, { capture: true, once: true });
    document.execCommand('copy');
    document.removeEventListener('copy', listener, { capture: true });
    if (success) return true;
  } catch (err) {
    console.warn('execCommand copy fallback failed:', err);
  }

  return false;
}

async function copyFromPage(payload: string): Promise<{ ok: boolean; error?: string }> {
  try {
    window.focus();
    if (document.hasFocus()) {
      await navigator.clipboard.writeText(payload);
      return { ok: true };
    }
  } catch {
    // Fall through to textarea
  }

  try {
    const area = document.createElement('textarea');
    area.value = payload;
    area.style.position = 'fixed';
    area.style.left = '0';
    area.style.top = '0';
    area.style.width = '20px';
    area.style.height = '20px';
    area.style.opacity = '0.01';
    area.style.zIndex = '2147483647';
    document.body.appendChild(area);
    area.focus();
    area.select();
    area.setSelectionRange(0, payload.length);
    const copied = document.execCommand('copy');
    area.remove();
    if (copied) return { ok: true };
  } catch {
    // Fall through to manual button
  }

  showManualCopyPrompt(payload);
  return { ok: true };
}

function showManualCopyPrompt(payload: string): void {
  const existing = document.getElementById('web2figma-manual-copy');
  if (existing) existing.remove();

  const container = document.createElement('div');
  container.id = 'web2figma-manual-copy';
  container.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:24px',
    'transform:translateX(-50%)',
    'z-index:2147483647',
    'background:#111827',
    'color:#fff',
    'padding:12px 18px',
    'border-radius:10px',
    'font:13px/1.4 system-ui,sans-serif',
    'box-shadow:0 12px 32px rgba(0,0,0,0.35)',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'border:1px solid #374151',
  ].join(';');

  const label = document.createElement('span');
  label.textContent = 'Element captured!';

  const btn = document.createElement('button');
  btn.textContent = '📋 Click to Copy for Figma';
  btn.style.cssText = [
    'background:#0d99ff',
    'color:#fff',
    'border:none',
    'padding:6px 14px',
    'border-radius:6px',
    'font-weight:600',
    'cursor:pointer',
  ].join(';');

  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(payload);
      btn.textContent = '✅ Copied!';
      btn.style.background = '#10b981';
      setTimeout(() => container.remove(), 1500);
    } catch {
      toast('Clipboard write failed', 'error');
    }
  };

  const closeBtn = document.createElement('span');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'cursor:pointer;color:#9ca3af;margin-left:4px;font-size:14px;';
  closeBtn.onclick = () => container.remove();

  container.append(label, btn, closeBtn);
  document.body.appendChild(container);
  setTimeout(() => container.remove(), 12000);
}

const MESSAGE_LIMIT = 30 * 1024 * 1024;

async function deliver(
  doc: IRDocument,
  transport: 'clipboard' | 'relay',
  copyHere: boolean,
): Promise<CaptureOutcome> {
  const payload = await encodePayload(doc);
  const tooBigToMessage = !copyHere && payload.length > MESSAGE_LIMIT;

  // Always attempt to send to local relay in background (best-effort sync)
  try {
    void chrome.runtime.sendMessage({
      type: 'post-relay',
      doc,
    });
  } catch {
    // Relay may not be running, ignore
  }

  if (transport === 'relay' || tooBigToMessage) {
    const response = (await chrome.runtime.sendMessage({
      type: 'post-relay',
      doc,
    })) as { ok: boolean; error?: string };
    if (response?.ok) {
      toast('Sent to local relay. Open the Figma plugin and press Latest capture.');
      return { ok: true, bytes: payload.length, transport: 'relay' };
    }
    if (tooBigToMessage) {
      const mb = (payload.length / 1024 / 1024).toFixed(0);
      toast(
        `Capture is ${mb}MB, too large for clipboard. Start local relay (pnpm relay).`,
        'error',
      );
      return {
        ok: false,
        bytes: payload.length,
        error: `Capture is ${mb}MB; use relay`,
      };
    }
    toast(`Relay unavailable (${response?.error ?? 'no response'}), copying instead`, 'error');
  }

  if (!copyHere) {
    return { ok: true, bytes: payload.length, transport: 'clipboard', payload };
  }

  const copy = await copyFromPage(payload);
  if (copy.ok) {
    return { ok: true, bytes: payload.length, transport: 'clipboard' };
  }

  return { ok: false, bytes: payload.length, error: copy.error ?? 'clipboard unavailable' };
}

/**
 * Capture with native Figma H2D format (for direct Ctrl+V on Figma canvas)
 */
async function captureNativeFigma(
  selector: string,
  options: CaptureRequest,
): Promise<CaptureOutcome> {
  const win = window as unknown as {
    figma?: {
      serializeForDesign?: (selector?: string) => Promise<string>;
      captureForDesign?: (options: { selector?: string }) => Promise<{ success: boolean }>;
    };
  };

  if (!win.figma?.serializeForDesign) {
    try {
      await chrome.runtime.sendMessage({ type: 'ensure-capture-script' });
      await new Promise((r) => setTimeout(r, 80));
    } catch {}
  }

  if (win.figma?.serializeForDesign) {
    try {
      const serialized = await win.figma.serializeForDesign(selector);
      const htmlPayload = createFigmaH2DClipboardHtml(serialized);

      if (!options.copyHere) {
        return {
          ok: true,
          directPaste: true,
          htmlPayload,
          textPayload: serialized,
          transport: 'clipboard',
        };
      }

      const copied = await copyH2DFromPage(htmlPayload, serialized);
      if (copied) {
        toast('✅ Page copied! Go to Figma and press Ctrl+V directly on canvas.');
        return { ok: true, directPaste: true, transport: 'clipboard' };
      }
    } catch (err) {
      console.warn('Native capture failed, falling back to Web2Figma IR:', err);
    }
  }

  // Fallback to standard IR if native serializer is unavailable
  return runStandardCapture(document.documentElement, options);
}

/**
 * Capture a specific picked element with native Figma H2D format (for direct Ctrl+V on Figma canvas)
 */
async function captureNativeFigmaElement(
  target: Element,
  options: CaptureRequest,
): Promise<CaptureOutcome> {
  const win = window as unknown as {
    figma?: {
      serializeForDesign?: (selector?: string) => Promise<string>;
    };
  };

  toast('Capturing element for Figma direct paste...');

  if (!win.figma?.serializeForDesign) {
    try {
      await chrome.runtime.sendMessage({ type: 'ensure-capture-script' });
      await new Promise((r) => setTimeout(r, 80));
    } catch {}
  }

  if (win.figma?.serializeForDesign) {
    const pickId = `w2f-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    target.setAttribute('data-w2f-pick', pickId);
    const selector = `[data-w2f-pick="${pickId}"]`;

    try {
      const serialized = await win.figma.serializeForDesign(selector);
      const htmlPayload = createFigmaH2DClipboardHtml(serialized);

      const copied = await copyH2DFromPage(htmlPayload, serialized);
      if (copied) {
        toast('✅ Element copied! Go to Figma and press Ctrl+V directly on the canvas.');
        return { ok: true, directPaste: true, transport: 'clipboard' };
      }
    } catch (err) {
      console.warn('Native element capture failed, falling back to Web2Figma IR:', err);
    } finally {
      target.removeAttribute('data-w2f-pick');
    }
  }

  // Fallback to standard IR if native serializer is unavailable or failed
  return runStandardCapture(target, { ...options, copyHere: true });
}

async function runStandardCapture(
  root: Element,
  options: CaptureRequest,
): Promise<CaptureOutcome> {
  const isSingle = root !== document.documentElement && root !== document.body;
  toast(isSingle ? 'Capturing element...' : 'Capturing...');
  const { doc: raw, elapsedMs } = await captureDocument(root, {
    dismissOverlays: isSingle ? false : (options.dismissOverlays ?? true),
    skipScroll: isSingle,
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
  if (result.ok) {
    toast(
      `✅ Captured ${stats.nodesOut} nodes (${coverage}% auto layout, ${(elapsedMs / 1000).toFixed(1)}s). Paste into Web2Figma plugin in Figma!`,
    );
  } else {
    toast(`Capture error: ${result.error ?? 'could not copy to clipboard'}`, 'error');
  }
  return { ...result, nodes: stats.nodesOut };
}

chrome.runtime.onMessage.addListener((request: Request, _sender, sendResponse) => {
  if (request.type === 'ping') {
    const win = window as unknown as { figma?: { serializeForDesign?: unknown } };
    sendResponse({ ok: true, hasNative: Boolean(win.figma?.serializeForDesign) });
    return false;
  }

  if (request.type === 'capture-page') {
    const isDirect = request.directPaste !== false;
    const promise = isDirect
      ? captureNativeFigma('body', request)
      : runStandardCapture(document.documentElement, request);

    void promise.then(sendResponse, (err: unknown) =>
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
        const isDirect = request.directPaste !== false;
        if (isDirect) {
          void captureNativeFigmaElement(target, request);
        } else {
          void runStandardCapture(target, { ...request, copyHere: true });
        }
      },
      onCancel: () => toast('Picker cancelled'),
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

void chrome.runtime.sendMessage({ type: 'content-ready', href: location.href }).catch(() => undefined);
