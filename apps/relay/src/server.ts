import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IRDocument } from '@web2figma/ir';
import { DEFAULT_BREAKPOINTS, combineDocuments, transformDocument } from '@web2figma/transform';
import { imageToHtml } from '@web2figma/image-pipeline';
import { closeBrowser, decodeImage, renderHtml, renderUrl, screenshotHtml } from './renderer.js';
import { createGeminiVisionModel } from './gemini.js';

// Find and load .env from current or any parent directory
function loadEnv(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      try {
        const lines = readFileSync(candidate, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq !== -1) {
            const k = trimmed.slice(0, eq).trim();
            let v = trimmed.slice(eq + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
              v = v.slice(1, -1);
            }
            if (!process.env[k]) process.env[k] = v;
          }
        }
        return candidate;
      } catch {
        // continue search
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
loadEnv();

/**
 * T2 local relay (PRD section 6).
 *
 * Runs on the user's machine, holds captures in memory, and renders URLs with
 * Playwright. Nothing is written to disk and nothing leaves the machine.
 */

const PORT = Number(process.env.PORT ?? process.env.WEB2FIGMA_PORT ?? 3579);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAX_BODY = 200 * 1024 * 1024;

interface StoredCapture {
  id: string;
  doc: IRDocument;
  at: number;
}

const captures = new Map<string, StoredCapture>();
let latestId: string | null = null;

function cors(res: ServerResponse): void {
  // The plugin iframe has a null origin, so the allowlist cannot be narrower.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('payload too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function store(doc: IRDocument): string {
  const id = randomUUID();
  captures.set(id, { id, doc, at: Date.now() });
  latestId = id;
  // Keep memory bounded: a handful of captures is all anyone needs open.
  if (captures.size > 8) {
    const oldest = [...captures.values()].sort((a, b) => a.at - b.at)[0];
    if (oldest) captures.delete(oldest.id);
  }
  return id;
}

/** Name a width the way a designer would. */
function labelFor(width: number): string {
  const known = DEFAULT_BREAKPOINTS.find((b) => b.width === width);
  if (known) return known.label;
  if (width <= 480) return 'Mobile';
  if (width <= 1024) return 'Tablet';
  return 'Desktop';
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err: unknown) => {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    const latest = latestId ? captures.get(latestId) : undefined;
    json(res, 200, {
      ok: true,
      captures: captures.size,
      latestId: latestId ?? null,
      latestAt: latest?.at ?? null,
      latestSource: latest?.doc?.source?.ref ?? null,
      version: 1,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    });
    return;
  }

  // The extension posts a finished IR here.
  if (url.pathname === '/ir' && req.method === 'POST') {
    const doc = JSON.parse(await readBody(req)) as IRDocument;
    const id = store(doc);
    json(res, 200, { id });
    return;
  }

  if (url.pathname.startsWith('/ir/') && req.method === 'GET') {
    const id = url.pathname.slice('/ir/'.length);
    const entry = id === 'latest' ? (latestId ? captures.get(latestId) : undefined) : captures.get(id);
    if (!entry) {
      json(res, 404, { error: 'no capture with that id' });
      return;
    }
    json(res, 200, entry.doc);
    return;
  }

  // Render a URL headlessly and return the transformed IR. One request can ask
  // for several breakpoints, which come back as one document laid out in a row.
  if (url.pathname === '/render' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as {
      url: string;
      width?: number;
      widths?: number[];
      breakpoints?: { label: string; width: number }[];
      fullPage?: boolean;
      autoLayout?: boolean;
      colorScheme?: 'light' | 'dark';
      cookies?: { name: string; value: string; domain: string }[];
    };
    if (!body.url) {
      json(res, 400, { error: 'url is required' });
      return;
    }

    const requested =
      body.breakpoints && body.breakpoints.length > 0
        ? body.breakpoints
        : body.widths && body.widths.length > 0
          ? body.widths.map((w) => ({ label: labelFor(w), width: w }))
          : [{ label: labelFor(body.width ?? 1440), width: body.width ?? 1440 }];

    const captured = [];
    for (const breakpoint of requested) {
      const raw = await renderUrl(body.url, {
        width: breakpoint.width,
        ...(body.fullPage !== undefined ? { fullPage: body.fullPage } : {}),
        ...(body.colorScheme ? { colorScheme: body.colorScheme } : {}),
        ...(body.cookies ? { cookies: body.cookies } : {}),
      });
      const { doc } = transformDocument(raw, { disableAutoLayout: body.autoLayout === false });
      captured.push({ doc, label: breakpoint.label, width: breakpoint.width });
    }

    const doc = combineDocuments(captured);
    store(doc);
    json(res, 200, doc);
    return;
  }

  // Image -> HTML -> the existing capture pipeline (PRD section 9).
  if (url.pathname === '/image' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as {
      image: string;
      width?: number;
      iterations?: number;
      apiKey?: string;
    };
    if (!body.image) {
      json(res, 400, { error: 'image is required' });
      return;
    }

    const apiKey = (body.apiKey && body.apiKey.trim()) || process.env.GEMINI_API_KEY;
    const model = apiKey ? createGeminiVisionModel(apiKey) : undefined;

    const synthesis = await imageToHtml(body.image, {
      ...(body.width !== undefined ? { width: body.width } : {}),
      iterations: body.iterations ?? 1,
      model,
      decode: decodeImage,
      renderHtml: async (html, width) => screenshotHtml(html, { width }),
    });

    // If synthesis produced an empty body with no content, fallback to embedding the image directly
    const bodyContent = synthesis.html.replace(/[\s\S]*<body[^>]*>([\s\S]*)<\/body>[\s\S]*/i, '$1').trim();
    const htmlToRender = bodyContent.length === 0
      ? `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;width:${synthesis.width}px;display:flex;background:#ffffff;}img{width:100%;height:auto;display:block;}</style></head><body><img src="${body.image}" alt="Captured design"/></body></html>`
      : synthesis.html;

    const raw = await renderHtml(htmlToRender, { width: synthesis.width, height: synthesis.height });
    const { doc } = transformDocument(raw);
    doc.warnings.push(...synthesis.warnings);
    store(doc);
    json(res, 200, doc);
    return;
  }

  json(res, 404, { error: 'not found' });
}

server.listen(PORT, HOST, () => {
  console.log(`web2figma relay listening on http://${HOST}:${PORT}`);
  console.log(`  Vision AI (Gemini): ${process.env.GEMINI_API_KEY ? 'READY (Key loaded)' : 'OFFLINE (No key in .env)'}`);
  console.log('  POST /ir           store a capture from the extension');
  console.log('  GET  /ir/latest    fetch the newest capture');
  console.log('  POST /render       render a URL with Playwright');
  console.log('  POST /image        convert a screenshot to editable IR');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void closeBrowser().finally(() => process.exit(0));
  });
}
