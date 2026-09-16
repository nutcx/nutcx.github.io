import { loadPreviewHistory } from '../lib/retirements.mjs';
export async function GET() {
  return new Response(JSON.stringify({ version: 1, items: (await loadPreviewHistory()).history }), { headers: { 'Content-Type': 'application/json' } });
}
