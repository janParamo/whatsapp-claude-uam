// Servidor local para probar en tu computadora (en producción se usa api/webhook.js en Vercel).
import 'dotenv/config';
import express from 'express';
import { processWebhook, missingEnv } from '../lib/assistant.js';

const { PORT = 3000, WEBHOOK_SECRET } = process.env;

const missing = missingEnv();
if (missing.length) {
  console.error('Faltan variables en .env:', missing.join(', '));
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/api/webhook', (_req, res) => res.json({ ok: true }));

app.post('/api/webhook', (req, res) => {
  if (req.query.key !== WEBHOOK_SECRET) return res.sendStatus(404);
  res.sendStatus(200); // responder rápido; el trabajo sigue aparte
  processWebhook(req.body, (name) => req.get(name) ?? null).catch((err) => console.error(err));
});

app.listen(PORT, () => {
  console.log(`Asistente local en http://localhost:${PORT}/api/webhook?key=…`);
});
