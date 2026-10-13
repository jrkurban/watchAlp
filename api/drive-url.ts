import { resolveDriveMediaUrl } from '../src/lib/resolveDriveMedia';

type VercelReq = { method?: string; query?: { id?: string | string[] } };
type VercelRes = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => { json: (body: unknown) => void };
};

function queryId(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function handler(req: VercelReq, res: VercelRes) {
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ error: 'method' });
    return;
  }

  const id = queryId(req.query?.id).trim();
  if (!id) {
    res.status(400).json({ error: 'missing id' });
    return;
  }

  try {
    const result = await resolveDriveMediaUrl(id);
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not open this Drive file.' });
  }
}
