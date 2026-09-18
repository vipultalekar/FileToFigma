/** Popup: chooses options, then hands the work to the content script. */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

// `status` is a global on Window, so the element gets its own name.
const statusEl = $('status');

function setStatus(message: string, tone: 'info' | 'error' = 'info'): void {
  statusEl.textContent = message;
  statusEl.className = tone === 'error' ? 'status error' : 'status';
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }
}

async function send(type: 'capture-page' | 'pick-element'): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('No active tab', 'error');
    return;
  }
  const options = {
    dismissOverlays: $<HTMLInputElement>('overlays').checked,
    autoLayout: $<HTMLInputElement>('autolayout').checked,
    transport: $<HTMLInputElement>('relay').checked ? 'relay' : 'clipboard',
  };
  await chrome.storage.local.set({ options });

  try {
    setStatus(type === 'capture-page' ? 'Capturing...' : 'Pick an element in the page');
    await ensureContentScript(tab.id);
    const result = (await chrome.tabs.sendMessage(tab.id, { type, ...options })) as {
      ok: boolean;
      nodes?: number;
      transport?: string;
      error?: string;
    };
    if (type === 'pick-element') {
      window.close();
      return;
    }
    if (result?.ok) {
      setStatus(`${result.nodes ?? 0} nodes ready via ${result.transport ?? 'clipboard'}`);
    } else {
      setStatus(result?.error ?? 'Capture failed', 'error');
    }
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  }
}

void chrome.storage.local.get('options').then((stored) => {
  const options = stored.options as
    | { dismissOverlays: boolean; autoLayout: boolean; transport: string }
    | undefined;
  if (!options) return;
  $<HTMLInputElement>('overlays').checked = options.dismissOverlays;
  $<HTMLInputElement>('autolayout').checked = options.autoLayout;
  $<HTMLInputElement>('relay').checked = options.transport === 'relay';
});

$('capture').addEventListener('click', () => void send('capture-page'));
$('pick').addEventListener('click', () => void send('pick-element'));
