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

type Tab = 'paste' | 'url' | 'html' | 'image';

/** Every payload the extension writes starts with this. */
const PAYLOAD_PREFIX = 'W2F1:';

interface Status {
  kind: 'idle' | 'busy' | 'error' | 'done';
  message: string;
  done?: number;
  total?: number;
}

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('paste');
  const [status, setStatus] = useState<Status>({ kind: 'idle', message: 'Ready' });
  const [report, setReport] = useState<ConversionReport | null>(null);
  const [relayUp, setRelayUp] = useState<boolean | null>(null);
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

  useEffect(() => {
    void relayHealth().then(setRelayUp);
  }, []);

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

      <nav className="tabs">
        {(['paste', 'url', 'html', 'image'] as Tab[]).map((t) => (
          <button key={t} className={t === tab ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {t === 'paste' ? 'Paste' : t === 'url' ? 'URL' : t === 'html' ? 'Local HTML' : 'Image'}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'paste' && <PasteTab run={run} />}
        {tab === 'url' && <UrlTab run={run} relayUp={relayUp} />}
        {tab === 'html' && <HtmlTab run={run} />}
        {tab === 'image' && <ImageTab run={run} relayUp={relayUp} />}
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

function PasteTab({ run }: TabProps): JSX.Element {
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);

  // Figma's desktop app sends keystrokes to the canvas unless a field inside
  // the plugin iframe holds focus, so the box focuses itself on open.
  useEffect(() => {
    field.current?.focus();
  }, []);

  const readClipboard = async (): Promise<void> => {
    setNote('');
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setNote('The clipboard is empty. Capture a page with the extension first.');
        return;
      }
      setValue(text);
      await run('Decoding payload', () => decodeClipboard(text));
    } catch (err) {
      setNote(
        `Figma would not let the plugin read the clipboard (${
          err instanceof Error ? err.message : String(err)
        }). Click inside the box below and press Ctrl+V.`,
      );
      field.current?.focus();
    }
  };

  return (
    <section>
      <p className="hint">
        Capture a page with the Web2Figma extension, then bring the payload over. Pasting
        anywhere in this panel works.
      </p>
      <div className="row">
        <button className="primary" onClick={() => void readClipboard()}>
          Read clipboard
        </button>
        <button
          disabled={value.trim() === ''}
          onClick={() => void run('Decoding payload', () => decodeClipboard(value))}
        >
          Import payload
        </button>
      </div>
      {note && <p className="warn">{note}</p>}
      <textarea
        ref={field}
        value={value}
        placeholder="...or click here and press Ctrl+V"
        onChange={(e) => setValue(e.currentTarget.value)}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (text) {
            setValue(text);
            void run('Decoding payload', () => decodeClipboard(text));
          }
        }}
      />
      {value.trim() !== '' && (
        <p className="hint">{value.length.toLocaleString()} characters in the box</p>
      )}
    </section>
  );
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

  return (
    <section>
      <p className="hint">
        {relayUp
          ? 'The local relay renders the page with Playwright and sends back the IR.'
          : 'Start the local relay first: pnpm relay (listens on localhost:3579).'}
      </p>
      <input
        type="url"
        placeholder="https://example.com"
        value={url}
        onChange={(e) => setUrl(e.currentTarget.value)}
      />

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
            {widths.length} captures, laid out side by side in one frame.
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

      <div className="row">
        <button
          className="primary"
          disabled={!relayUp || url.trim() === '' || widths.length === 0}
          onClick={() =>
            void run('Rendering page', () =>
              relayRender(url, { widths, fullPage: true, colorScheme: theme }),
            )
          }
        >
          {widths.length > 1 ? `Import ${widths.length} breakpoints` : 'Import URL'}
        </button>
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
          Latest capture
        </button>
      </div>
    </section>
  );
}

function HtmlTab({ run }: TabProps): JSX.Element {
  const [html, setHtml] = useState('');
  const [width, setWidth] = useState(1440);
  return (
    <section>
      <p className="hint">
        Drop a self-contained HTML file. It renders in a hidden iframe here, with no
        network round trip.
      </p>
      <div
        className="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (!file) return;
          void file.text().then((text) => {
            setHtml(text);
            void run('Rendering HTML', () =>
              captureInIframe(text, { width, skipPrepare: false, sourceRef: file.name }).then((r) => r.doc),
            );
          });
        }}
      >
        Drop an .html file
      </div>
      <textarea
        value={html}
        placeholder="...or paste HTML"
        onChange={(e) => setHtml(e.currentTarget.value)}
      />
      <button
        className="primary"
        disabled={html.trim() === ''}
        onClick={() =>
          void run('Rendering HTML', () =>
            captureInIframe(html, { width, sourceRef: 'pasted-html' }).then((r) => r.doc),
          )
        }
      >
        Import HTML
      </button>
      <label className="row">
        Viewport width
        <input
          type="number"
          value={width}
          onChange={(e) => setWidth(Number(e.currentTarget.value))}
        />
      </label>
    </section>
  );
}

function ImageTab({ run, relayUp }: TabProps & { relayUp: boolean | null }): JSX.Element {
  const [note, setNote] = useState('');
  return (
    <section>
      <p className="hint">
        A screenshot becomes a starting point, not a reproduction. Use a full-resolution,
        uncropped image at least 1000px wide.
      </p>
      <div
        className="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = String(reader.result);
            const img = new Image();
            img.onload = () => {
              if (img.width < 1000) {
                setNote(`That image is ${img.width}px wide; quality degrades below 1000px.`);
              }
              void run('Reading the image', () => relayImage(dataUrl, { width: img.width }));
            };
            img.src = dataUrl;
          };
          reader.readAsDataURL(file);
        }}
      >
        {relayUp ? 'Drop a PNG or JPG' : 'Start the local relay to use the image pipeline'}
      </div>
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
