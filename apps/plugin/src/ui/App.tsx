import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BuilderMessage, ConversionReport, IRDocument } from '@web2figma/ir';
import { groupWarnings } from '@web2figma/shared';
import { DEFAULT_BREAKPOINTS, transformDocument } from '@web2figma/transform';
import { captureInIframe } from '@web2figma/capture';
import {
  SandboxBridge,
  decodeClipboard,
  relayHealth,
  relayImage,
  relayLatest,
  relayRender,
} from './transport.js';

type Tab = 'url' | 'html' | 'image';

/** Every payload the extension writes starts with this. */
const PAYLOAD_PREFIX = 'W2F1:';

interface Status {
  kind: 'idle' | 'busy' | 'error' | 'done';
  message: string;
  done?: number;
  total?: number;
}

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('url');
  const [status, setStatus] = useState<Status>({ kind: 'idle', message: 'Ready' });
  const [report, setReport] = useState<ConversionReport | null>(null);
  const [relayStatus, setRelayStatus] = useState<{ up: boolean | null; geminiConfigured?: boolean }>({
    up: null,
  });
  const [newRelayCapture, setNewRelayCapture] = useState<{
    id: string;
    source?: string;
  } | null>(null);
  const lastImportedIdRef = useRef<string | null>(null);
  const [autoLayout, setAutoLayout] = useState(true);
  const [createStyles, setCreateStyles] = useState(false);
  const bridgeRef = useRef<SandboxBridge | null>(null);

  const bridge = useMemo(() => {
    const b = new SandboxBridge((message: BuilderMessage) => {
      if (message.t === 'progress') {
        setStatus({
          kind: 'busy',
          message: `Building (${message.stage})`,
          done: message.done,
          total: message.total,
        });
      } else if (message.t === 'done') {
        setReport(message.report);
        setStatus({ kind: 'done', message: `Done in ${(message.report.elapsedMs / 1000).toFixed(1)}s` });
      } else if (message.t === 'error') {
        setStatus({ kind: 'error', message: message.message });
      }
    });
    bridgeRef.current = b;
    return b;
  }, []);

  const checkRelay = useCallback(async () => {
    const info = await relayHealth();
    setRelayStatus({ up: info.ok, geminiConfigured: info.geminiConfigured });
    if (info.ok && info.latestId && info.latestId !== lastImportedIdRef.current) {
      setNewRelayCapture({
        id: info.latestId,
        source: info.latestSource ? String(info.latestSource).slice(0, 30) : undefined,
      });
    }
  }, []);

  useEffect(() => {
    void checkRelay();
    const interval = setInterval(() => void checkRelay(), 3000);
    const onFocus = () => void checkRelay();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [checkRelay]);

  const run = useCallback(
    async (label: string, produce: () => Promise<IRDocument>) => {
      setReport(null);
      setStatus({ kind: 'busy', message: label });
      try {
        const raw = await produce();
        setStatus({ kind: 'busy', message: 'Inferring layout' });
        const { doc, stats } = transformDocument(raw, { disableAutoLayout: !autoLayout });
        setStatus({
          kind: 'busy',
          message: `Sending ${stats.nodesOut} nodes`,
        });
        await bridge.sendDocument(doc, { createStyles });
      } catch (err) {
        setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    },
    [autoLayout, bridge, createStyles],
  );

  const importLatest = useCallback(() => {
    void run('Fetching latest capture from relay', async () => {
      const doc = await relayLatest();
      if (!doc) throw new Error('No capture found on relay yet. Pick an element or capture a page first.');
      if (newRelayCapture?.id) {
        lastImportedIdRef.current = newRelayCapture.id;
      }
      setNewRelayCapture(null);
      return doc;
    });
  }, [run, newRelayCapture]);

  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim().startsWith(PAYLOAD_PREFIX)) {
        void run('Decoding payload', () => decodeClipboard(text));
        return;
      }
      setStatus({
        kind: 'error',
        message: 'Clipboard is empty or does not contain a Web2Figma capture.',
      });
    } catch {
      setStatus({
        kind: 'error',
        message: 'Please press Ctrl+V anywhere in this window to paste.',
      });
    }
  }, [run]);

  // A paste anywhere in the plugin panel counts, not only inside the textarea:
  // in the Figma desktop app it is easy to press Ctrl+V while focus sits
  // somewhere else in the iframe, and the payload is then silently lost.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData('text') ?? '';
      if (!text.trim().startsWith(PAYLOAD_PREFIX)) return;
      const target = event.target as HTMLElement | null;
      // The textarea handles its own paste; this is for everywhere else.
      if (target?.tagName === 'TEXTAREA') return;
      event.preventDefault();
      void run('Decoding payload', () => decodeClipboard(text));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [run]);

  return (
    <div className="app">
      <header>
        <span className="logo">Web2Figma</span>
        <div className="row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={autoLayout}
              onChange={(e) => setAutoLayout(e.currentTarget.checked)}
            />
            Auto Layout
          </label>
          <label className="toggle" title="Create Figma colour and text styles from values the page repeats">
            <input
              type="checkbox"
              checked={createStyles}
              onChange={(e) => setCreateStyles(e.currentTarget.checked)}
            />
            Styles
          </label>
        </div>
      </header>

      {newRelayCapture && (
        <div className="new-capture-banner">
          <div className="new-capture-text">
            <span>⚡ New capture ready{newRelayCapture.source ? ` (${newRelayCapture.source})` : ''}</span>
          </div>
          <button className="btn-banner-import" onClick={importLatest}>
            Import Now
          </button>
        </div>
      )}

      <div className="quick-toolbar">
        <button
          className="btn-quick"
          title="Paste Web2Figma capture from clipboard (Ctrl+V)"
          onClick={() => void pasteFromClipboard()}
        >
          📋 Paste Capture (Ctrl+V)
        </button>
        {relayStatus.up && (
          <button
            className="btn-quick relay-btn"
            title="Fetch the latest capture from the local relay"
            onClick={importLatest}
          >
            ⚡ Latest Capture
          </button>
        )}
      </div>

      <nav className="tabs">
        {(['url', 'html', 'image'] as Tab[]).map((t) => (
          <button key={t} className={t === tab ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {t === 'url' ? 'URL' : t === 'html' ? 'Local HTML' : 'Image'}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'url' && <UrlTab run={run} relayUp={relayStatus.up} />}
        {tab === 'html' && <HtmlTab run={run} />}
        {tab === 'image' && (
          <ImageTab
            run={run}
            relayUp={relayStatus.up}
            geminiConfigured={relayStatus.geminiConfigured}
          />
        )}
      </main>

      <StatusBar status={status} />
      {report && <Report report={report} bridge={bridge} />}

      <footer>
        <button className="ghost" onClick={() => bridge.command('demo')}>
          Build demo frame
        </button>
        <button className="ghost" onClick={() => bridge.command('close')}>
          Close
        </button>
      </footer>
    </div>
  );
}

interface TabProps {
  run: (label: string, produce: () => Promise<IRDocument>) => Promise<void>;
}

function UrlTab({ run, relayUp }: TabProps & { relayUp: boolean | null }): JSX.Element {
  const [url, setUrl] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [widths, setWidths] = useState<number[]>([1440]);

  const toggleWidth = (width: number): void => {
    setWidths((current) =>
      current.includes(width)
        ? current.filter((w) => w !== width)
        : [...current, width].sort((a, b) => b - a),
    );
  };

  const getCleanUrl = (): string => {
    const trimmed = url.trim();
    if (!trimmed) return '';
    return trimmed.match(/^https?:\/\//i) ? trimmed : `https://${trimmed}`;
  };

  const handleImport = (): void => {
    const cleanUrl = getCleanUrl();
    if (!cleanUrl || widths.length === 0 || !relayUp) return;
    void run('Rendering page', () =>
      relayRender(cleanUrl, { widths, fullPage: true, colorScheme: theme }),
    );
  };

  return (
    <section>
      <div
        style={{
          padding: '8px 10px',
          borderRadius: '6px',
          fontSize: '11px',
          background: relayUp ? 'rgba(34, 197, 94, 0.12)' : 'rgba(234, 179, 8, 0.12)',
          border: `1px solid ${relayUp ? 'rgba(34, 197, 94, 0.3)' : 'rgba(234, 179, 8, 0.3)'}`,
          color: relayUp ? '#22c55e' : '#eab308',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        <span>{relayUp ? '🟢 Local Relay Connected' : '🟡 Local Relay Offline'}</span>
        <span style={{ color: 'var(--muted)', fontSize: '10px' }}>
          {relayUp
            ? '(Playwright headless ready)'
            : '— run `pnpm relay` in terminal to import live URLs'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <input
          type="url"
          placeholder="Enter website URL (e.g. stripe.com)"
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleImport();
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          className="primary"
          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
          disabled={!relayUp || url.trim() === '' || widths.length === 0}
          onClick={handleImport}
        >
          {widths.length > 1 ? `Import (${widths.length})` : 'Import'}
        </button>
      </div>

      <div className="field">
        <span className="label">Breakpoints</span>
        <div className="row wrap">
          {DEFAULT_BREAKPOINTS.map((b) => (
            <label key={b.width} className="toggle">
              <input
                type="checkbox"
                checked={widths.includes(b.width)}
                onChange={() => toggleWidth(b.width)}
              />
              {b.label} {b.width}
            </label>
          ))}
        </div>
        {widths.length > 1 && (
          <p className="hint">
            {widths.length} responsive layouts, placed side-by-side in Figma.
          </p>
        )}
      </div>

      <div className="field">
        <span className="label">Theme</span>
        <div className="row">
          {(['light', 'dark'] as const).map((t) => (
            <label key={t} className="toggle">
              <input
                type="radio"
                name="theme"
                checked={theme === t}
                onChange={() => setTheme(t)}
              />
              {t === 'light' ? 'Light' : 'Dark'}
            </label>
          ))}
        </div>
      </div>

      <div className="row" style={{ marginTop: '4px' }}>
        <button
          disabled={!relayUp}
          onClick={() =>
            void run('Fetching last capture', async () => {
              const doc = await relayLatest();
              if (!doc) throw new Error('The relay has no capture yet.');
              return doc;
            })
          }
        >
          Fetch latest extension capture
        </button>
      </div>
    </section>
  );
}

function HtmlTab({ run }: TabProps): JSX.Element {
  const [html, setHtml] = useState('');
  const [width, setWidth] = useState(1440);
  const [fileName, setFileName] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = (file: File): void => {
    setFileName(file.name);
    void file.text().then((text) => {
      setHtml(text);
      void run('Rendering HTML', () =>
        captureInIframe(text, { width, skipPrepare: false, sourceRef: file.name }).then((r) => r.doc),
      );
    });
  };

  return (
    <section>
      <p className="hint">
        Drop or select a self-contained HTML file. It renders in a hidden iframe with zero network round trips.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept=".html,.htm,text/html"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) processFile(file);
          e.target.value = '';
        }}
      />

      <div
        className={`dropzone ${isDragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragging(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) processFile(file);
        }}
        onClick={() => fileInputRef.current?.click()}
      >
        <span className="dropzone-icon">📄</span>
        <div>
          <strong style={{ display: 'block', marginBottom: '2px' }}>
            {fileName ? `Selected: ${fileName}` : 'Click to choose HTML file or drag & drop'}
          </strong>
          <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
            .html or .htm files
          </span>
        </div>
      </div>

      <textarea
        value={html}
        placeholder="...or paste HTML source code directly here"
        onChange={(e) => setHtml(e.currentTarget.value)}
      />
      <div className="row">
        <button
          className="primary"
          disabled={html.trim() === ''}
          onClick={() =>
            void run('Rendering HTML', () =>
              captureInIframe(html, { width, sourceRef: fileName || 'pasted-html' }).then((r) => r.doc),
            )
          }
        >
          Import HTML
        </button>
        <label className="row" style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--muted)' }}>
          Width:
          <input
            type="number"
            value={width}
            onChange={(e) => setWidth(Number(e.currentTarget.value))}
            style={{ width: '70px', padding: '4px 6px' }}
          />
        </label>
      </div>
    </section>
  );
}

interface ImageInfo {
  dataUrl: string;
  name: string;
  size: number;
  width: number;
  height: number;
}

function ImageTab({
  run,
  relayUp,
  geminiConfigured,
}: TabProps & { relayUp: boolean | null; geminiConfigured?: boolean }): JSX.Element {
  const [image, setImage] = useState<ImageInfo | null>(null);
  const [note, setNote] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [apiKey, setApiKey] = useState(() => {
    try {
      return localStorage.getItem('web2figma_gemini_key') ?? '';
    } catch {
      return '';
    }
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = (file: File): void => {
    if (!file.type.startsWith('image/')) {
      setNote('Please select an image file (PNG, JPG, or WebP).');
      return;
    }
    setNote('');
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => {
        if (img.width < 1000) {
          setNote(`Image is ${img.width}px wide; conversion quality is best with images ≥ 1000px.`);
        }
        setImage({
          dataUrl,
          name: file.name,
          size: file.size,
          width: img.width,
          height: img.height,
        });
      };
      img.onerror = () => {
        setNote('Could not read image dimensions. Please try another image.');
      };
      img.src = dataUrl;
    };
    reader.onerror = () => {
      setNote('Failed to read file from disk.');
    };
    reader.readAsDataURL(file);
  };

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      processFile(file);
    }
  };

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  // Support pasting image from clipboard (e.g. Snipping Tool / Win+Shift+S)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) {
            e.preventDefault();
            processFile(file);
            return;
          }
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, []);

  const handleConvert = (): void => {
    if (!image || !relayUp) return;
    void run('Reconstructing design with Gemini', () =>
      relayImage(image.dataUrl, {
        width: image.width,
        apiKey: apiKey.trim() || undefined,
      }),
    );
  };

  return (
    <section>
      <div
        style={{
          padding: '8px 10px',
          borderRadius: '6px',
          fontSize: '11px',
          background: relayUp ? 'rgba(34, 197, 94, 0.12)' : 'rgba(234, 179, 8, 0.12)',
          border: `1px solid ${relayUp ? 'rgba(34, 197, 94, 0.3)' : 'rgba(234, 179, 8, 0.3)'}`,
          color: relayUp ? '#22c55e' : '#eab308',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        <span>{relayUp ? '🟢 Local Relay Connected' : '🟡 Local Relay Offline'}</span>
        <span style={{ color: 'var(--muted)', fontSize: '10px' }}>
          {relayUp
            ? geminiConfigured
              ? '(Gemini Vision AI active)'
              : '(Vision synthesis ready)'
            : '— run `pnpm relay` in terminal to convert images'}
        </span>
      </div>

      <div className="field" style={{ gap: '4px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="label">
            Gemini Vision Key {geminiConfigured ? '✓ (Loaded)' : '(Free)'}
          </span>
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: '10px', color: 'var(--accent)', textDecoration: 'none' }}
          >
            Get free key ↗
          </a>
        </div>
        <input
          type="password"
          placeholder={
            geminiConfigured
              ? 'Key loaded from .env (Active)'
              : 'Paste API key here (or set in .env)'
          }
          value={apiKey}
          onChange={(e) => {
            const val = e.currentTarget.value;
            setApiKey(val);
            try {
              localStorage.setItem('web2figma_gemini_key', val);
            } catch {
              // ignore
            }
          }}
          style={{ fontSize: '11px', padding: '6px 8px' }}
        />
      </div>

      <p className="hint">
        Convert screenshots or designs into editable Figma components. Works best with images at least 1000px wide.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) processFile(file);
          e.target.value = '';
        }}
      />

      {!image ? (
        <div
          className={`dropzone ${isDragging ? 'dragging' : ''}`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <span className="dropzone-icon">🖼️</span>
          <div>
            <strong style={{ display: 'block', marginBottom: '2px' }}>
              Click to choose image or drag & drop here
            </strong>
            <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
              PNG, JPG, or WebP (or press Ctrl+V to paste screenshot)
            </span>
          </div>
        </div>
      ) : (
        <div className="preview-container">
          <img src={image.dataUrl} alt="Selected preview" className="preview-img" />
          <div className="preview-meta">
            <span>{image.name || 'Screenshot'}</span>
            <span>•</span>
            <span>{image.width} × {image.height} px</span>
            <span>•</span>
            <span>{(image.size / 1024).toFixed(0)} KB</span>
          </div>
          <div className="row" style={{ width: '100%', justifyContent: 'center', gap: '8px' }}>
            <button
              className="primary"
              disabled={!relayUp}
              onClick={handleConvert}
            >
              Convert to Figma
            </button>
            <button
              className="ghost"
              onClick={() => {
                setImage(null);
                setNote('');
              }}
            >
              Choose different image
            </button>
          </div>
        </div>
      )}

      {note && <p className="warn">{note}</p>}
    </section>
  );
}

function StatusBar({ status }: { status: Status }): JSX.Element {
  const pct =
    status.total && status.total > 0 ? Math.round(((status.done ?? 0) / status.total) * 100) : null;
  return (
    <div className={`status ${status.kind}`}>
      <span>{status.message}</span>
      {pct !== null && (
        <div className="bar">
          <div className="fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function Report({
  report,
  bridge,
}: {
  report: ConversionReport;
  bridge: SandboxBridge;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const coverage =
    report.autoLayoutCoverage.frames === 0
      ? 0
      : Math.round((report.autoLayoutCoverage.withLayout / report.autoLayoutCoverage.frames) * 100);
  const groups = groupWarnings(report.warnings).filter((g) => g.severity !== 'info');

  return (
    <section className="report">
      <button className="disclosure" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide' : 'Show'} conversion report
      </button>
      {open && (
        <>
          <dl>
            <div>
              <dt>Nodes</dt>
              <dd>
                {Object.entries(report.nodesCreated)
                  .map(([kind, n]) => `${n} ${kind}`)
                  .join(', ') || 'none'}
              </dd>
            </div>
            <div>
              <dt>Auto Layout</dt>
              <dd>
                {coverage}% of {report.autoLayoutCoverage.frames} frames
                {' ('}
                {Object.entries(report.autoLayoutCoverage.byReason)
                  .map(([reason, n]) => `${reason} ${n}`)
                  .join(', ')}
                {')'}
              </dd>
            </div>
          </dl>

          {report.stylesCreated && (
            <>
              <h3>Figma styles created</h3>
              <p className="hint">
                {report.stylesCreated.colors} colour, {report.stylesCreated.texts} text
              </p>
              <ul className="warnings">
                {report.stylesCreated.names.slice(0, 12).map((name) => (
                  <li key={name}>
                    <span className="prop">{name}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {report.fontSubstitutions.length > 0 && (
            <>
              <h3>Font substitutions</h3>
              <table>
                <tbody>
                  {report.fontSubstitutions.map((s) => (
                    <tr key={s.requested}>
                      <td>{s.requested}</td>
                      <td>{s.resolved}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {groups.length > 0 && (
            <>
              <h3>Degraded and dropped</h3>
              <ul className="warnings">
                {groups.map((g) => (
                  <li key={`${g.property}-${g.severity}`}>
                    <span className={`pill ${g.severity}`}>{g.severity}</span>
                    <span className="prop">{g.property}</span>
                    <span className="count">x{g.count}</span>
                    <button
                      className="link"
                      onClick={() => bridge.command('select-warned', { ids: g.nodeIds })}
                    >
                      select affected layers
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="row">
            <button className="ghost" onClick={() => bridge.command('flatten')}>
              Flatten inferred layouts
            </button>
            <button className="ghost" onClick={() => bridge.command('rasterise')}>
              Rasterise selection
            </button>
          </div>
        </>
      )}
    </section>
  );
}
