// Función de Vercel: https://TU-PROYECTO.vercel.app/api/webhook?key=TU_WEBHOOK_SECRET
import { waitUntil } from '@vercel/functions';
import { processWebhook, missingEnv } from '../lib/assistant.js';

// Tiempo máximo de la función (también definido en vercel.json)
export const maxDuration = 60;

export async function GET() {
  const missing = missingEnv();
  return Response.json(
    missing.length ? { ok: false, faltan: missing } : { ok: true },
    { status: missing.length ? 500 : 200 },
  );
}

export async function POST(request) {
  const url = new URL(request.url);
  if (!process.env.WEBHOOK_SECRET || url.searchParams.get('key') !== process.env.WEBHOOK_SECRET) {
    return new Response('Not found', { status: 404 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('JSON inválido', { status: 400 });
  }

  // Kapso exige un 200 en menos de 10 s: respondemos ya y Gemini trabaja en segundo plano.
  waitUntil(processWebhook(body, (name) => request.headers.get(name)));
  return new Response('ok', { status: 200 });
}
