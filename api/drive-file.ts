import { Readable } from 'node:stream';
import { openDriveFile } from '../src/lib/resolveDriveMedia';

export const config = { maxDuration: 300 };

type VercelReq = { method?: string; query?: { id?: string | string[] }; headers: Record<string, string | string[] | undefined> };
type VercelRes = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => { json: (body: unknown) => void; end: () => void };
  end: () => void;
  headersSent?: boolean;
} & NodeJS.WritableStream;

function queryId(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function handler(req: VercelReq, res: VercelRes) {
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'method' });
    return;
  }

  const id = queryId(req.query?.id).trim();
  if (!id) {
    res.status(400).json({ error: 'missing id' });
    return;
  }

  try {
    const rangeHeader = req.headers.range;
    const range = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader;
    const upstream = await openDriveFile(id, range);
    res.status(upstream.status);
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(502).json({ error: 'Could not stream this Drive file.' });
    else res.end();
  }
}
