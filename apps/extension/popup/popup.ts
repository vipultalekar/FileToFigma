/**
 * Popup Script: Device & orientation selector, viewport emulation, and capture dispatcher.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const $$ = <T extends HTMLElement>(selector: string): T[] => {
  return Array.from(document.querySelectorAll(selector)) as T[];
};

interface DeviceConfig {
  width: number;
  height: number;
  isMobile: boolean;
}

const DEVICE_PRESETS: Record<string, DeviceConfig> = {
  desktop: { width: 1440, height: 900, isMobile: false },
  laptop: { width: 1024, height: 768, isMobile: false },
  tablet: { width: 768, height: 1024, isMobile: true },
  mobile: { width: 390, height: 844, isMobile: true },
};

let currentDevice = 'desktop';
let currentOrientation = 'portrait';
let currentScope: 'full' | 'viewport' = 'full';

function updateDimensionsDisplay(): void {
  const preset = DEVICE_PRESETS[currentDevice];
  if (!preset) return;

  let w = preset.width;
  let h = preset.height;

  if (currentOrientation === 'landscape' && (currentDevice === 'tablet' || currentDevice === 'mobile')) {
    [w, h] = [h, w];
  }

  $('dim-tag').textContent = `${w} × ${h}`;
}

function setStatus(message: string, type: 'info' | 'loading' | 'error' = 'info'): void {
  const box = $('status-box');
  box.textContent = message;
  box.className = `status-box ${type}`;
}

function clearStatus(): void {
  const box = $('status-box');
  box.style.display = 'none';
  box.className = 'status-box';
}

// Device buttons click handlers
$$<HTMLButtonElement>('.device-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.device-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentDevice = btn.dataset.device ?? 'desktop';
    updateDimensionsDisplay();
  });
});

// Orientation buttons click handlers
$$<HTMLButtonElement>('.orient-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.orient-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentOrientation = btn.dataset.orient ?? 'portrait';
    updateDimensionsDisplay();
  });
});

// Scope buttons click handlers
$$<HTMLButtonElement>('.scope-btn').forEach((btn) => {
  if (btn.id === 'btn-pick') return;
  btn.addEventListener('click', () => {
    $$('.scope-btn').forEach((b) => {
      if (b.id !== 'btn-pick') b.classList.remove('active');
    });
    btn.classList.add('active');
    currentScope = (btn.dataset.scope as 'full' | 'viewport') ?? 'full';
  });
});

async function runCaptureFlow(type: 'capture-page' | 'pick-element'): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('No active tab found', 'error');
    return;
  }

  const directPaste = $<HTMLInputElement>('direct-paste').checked;
  const dismissOverlays = $<HTMLInputElement>('overlays').checked;
  const autoLayout = $<HTMLInputElement>('autolayout').checked;
  const transport = $<HTMLInputElement>('relay').checked ? 'relay' : 'clipboard';

  // Save options
  await chrome.storage.local.set({
    options: {
      currentDevice,
      currentOrientation,
      directPaste,
      dismissOverlays,
      autoLayout,
      transport,
    },
  });

  const captureBtn = $<HTMLButtonElement>('btn-capture');
  captureBtn.disabled = true;
  setStatus('Preparing capture...', 'loading');

  try {
    // 1. Ensure scripts are injected in target tab
    await chrome.runtime.sendMessage({ type: 'ensure-scripts', tabId: tab.id });

    if (type === 'pick-element') {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'pick-element',
        dismissOverlays,
        autoLayout,
        transport,
        directPaste,
      });
      window.close();
      return;
    }

    // 2. Determine target dimensions
    const preset = DEVICE_PRESETS[currentDevice];
    let targetW = preset.width;
    let targetH = preset.height;
    if (currentOrientation === 'landscape' && (currentDevice === 'tablet' || currentDevice === 'mobile')) {
      [targetW, targetH] = [targetH, targetW];
    }

    // 3. Set device metrics emulation if specific device is selected
    setStatus(`Emulating ${currentDevice} (${targetW}×${targetH})...`, 'loading');
    await chrome.runtime.sendMessage({
      type: 'set-emulation',
      tabId: tab.id,
      width: targetW,
      height: targetH,
      isMobile: preset.isMobile,
    });

    // Short pause for media queries to reflow
    await new Promise((resolve) => setTimeout(resolve, 250));

    // 4. Capture
    setStatus('Capturing elements...', 'loading');
    const result = (await chrome.tabs.sendMessage(tab.id, {
      type: 'capture-page',
      dismissOverlays,
      autoLayout,
      transport,
      directPaste,
      scope: currentScope,
    })) as {
      ok: boolean;
      nodes?: number;
      transport?: string;
      error?: string;
      payload?: string;
      directPaste?: boolean;
      htmlPayload?: string;
      textPayload?: string;
    };

    // 5. Restore viewport emulation
    await chrome.runtime.sendMessage({ type: 'clear-emulation', tabId: tab.id });

    if (!result?.ok) {
      setStatus(result?.error ?? 'Capture failed', 'error');
      return;
    }

    // 6. Write to clipboard
    if (result.directPaste && result.htmlPayload) {
      try {
        const item = new ClipboardItem({
          'text/html': new Blob([result.htmlPayload], { type: 'text/html' }),
          'text/plain': new Blob([result.textPayload || result.htmlPayload], { type: 'text/plain' }),
        });
        await navigator.clipboard.write([item]);
        setStatus('✅ Copied! Open Figma and press Ctrl+V', 'info');
      } catch (err) {
        setStatus(
          `Capture succeeded but clipboard write failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          'error',
        );
      }
    } else if (result.payload) {
      try {
        await navigator.clipboard.writeText(result.payload);
        setStatus('✅ Copied! Paste into Web2Figma plugin.', 'info');
      } catch (err) {
        setStatus('Clipboard write failed', 'error');
      }
    } else if (result.transport === 'relay') {
      setStatus('✅ Sent to local relay! Click Latest in plugin.', 'info');
    }
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    captureBtn.disabled = false;
  }
}

// Restore saved preferences
void chrome.storage.local.get('options').then((stored) => {
  const options = stored.options as
    | {
        currentDevice?: string;
        currentOrientation?: string;
        directPaste?: boolean;
        dismissOverlays?: boolean;
        autoLayout?: boolean;
        transport?: string;
      }
    | undefined;

  if (!options) return;

  if (options.currentDevice && DEVICE_PRESETS[options.currentDevice]) {
    currentDevice = options.currentDevice;
    $$('.device-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.device === currentDevice);
    });
  }

  if (options.currentOrientation) {
    currentOrientation = options.currentOrientation;
    $$('.orient-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.orient === currentOrientation);
    });
  }

  if (typeof options.directPaste === 'boolean') {
    $<HTMLInputElement>('direct-paste').checked = options.directPaste;
  }
  if (typeof options.dismissOverlays === 'boolean') {
    $<HTMLInputElement>('overlays').checked = options.dismissOverlays;
  }
  if (typeof options.autoLayout === 'boolean') {
    $<HTMLInputElement>('autolayout').checked = options.autoLayout;
  }
  if (options.transport) {
    $<HTMLInputElement>('relay').checked = options.transport === 'relay';
  }

  updateDimensionsDisplay();
});

$('btn-capture').addEventListener('click', () => void runCaptureFlow('capture-page'));
$('btn-pick').addEventListener('click', () => void runCaptureFlow('pick-element'));

updateDimensionsDisplay();
