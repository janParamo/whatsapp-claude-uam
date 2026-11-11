import { GoogleGenAI } from '@google/genai';
import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import { google } from 'googleapis';

// ─────────────────────────── Configuración ───────────────────────────
const env = process.env;
const TIMEZONE = env.TIMEZONE || 'America/Managua';
const GOOGLE_CALENDAR_ID = env.GOOGLE_CALENDAR_ID || 'primary';
const UTC_OFFSET = '-06:00'; // Nicaragua no usa horario de verano
const MAX_HISTORY = 20;      // turnos de texto guardados por conversación
const DONE_MARK = '✅';

// Tiempos máximos (la función de Vercel tiene 60 s en total)
const TOTAL_BUDGET_MS = 50_000;    // tiempo máximo para que Gemini termine de responder
const GEMINI_CALL_TIMEOUT_MS = 15_000; // tiempo máximo por cada llamada a Gemini
const SLOW_MODEL_COOLDOWN_MS = 15 * 60_000; // un modelo que se colgó pasa al final de la fila por 15 min
const GOOGLE_TIMEOUT_MS = 15_000;  // tiempo máximo por cada llamada a Google Calendar

// Modelos a probar en orden. Si uno está saturado (503), sin cuota (429), no existe (404)
// o tarda demasiado, se pasa al siguiente.
const GEMINI_MODELS = [
  env.GEMINI_MODEL,
  env.GEMINI_FALLBACK_MODEL,
  ...(env.GEMINI_MODELS || '').split(','),
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
]
  .map((m) => (m || '').trim())
  .filter((m, i, all) => m && all.indexOf(m) === i);

const REQUIRED = [
  'KAPSO_API_KEY', 'KAPSO_PHONE_NUMBER_ID', 'ALLOWED_NUMBER', 'WEBHOOK_SECRET',
  'GEMINI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN',
];

export function missingEnv() {
  return REQUIRED.filter((k) => !env[k]);
}

// ─────────────────────────── Clientes (se crean al primer uso) ───────────────────────────
let clients;
function getClients() {
  if (clients) return clients;
  const missing = missingEnv();
  if (missing.length) throw new Error('Faltan variables de entorno: ' + missing.join(', '));

  google.options({ timeout: GOOGLE_TIMEOUT_MS, retry: false });
  const oauth2 = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });

  clients = {
    whatsapp: new WhatsAppClient({
      baseUrl: env.KAPSO_BASE_URL || 'https://api.kapso.ai/meta/whatsapp',
      kapsoApiKey: env.KAPSO_API_KEY,
    }),
    gemini: new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }),
    calendar: google.calendar({ version: 'v3', auth: oauth2 }),
  };
  return clients;
}

// ─────────────────────────── Utilidades ───────────────────────────
const onlyDigits = (s = '') => String(s).replace(/\D/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (start) => ((Date.now() - start) / 1000).toFixed(1) + ' s';

// Acepta "2026-11-10", "2026-11-10T08:00" o con zona; devuelve RFC3339 con offset de Managua.
function toRfc3339(value, endOfDay = false) {
  if (!value) return undefined;
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T${endOfDay ? '23:59:59' : '00:00:00'}${UTC_OFFSET}`;
  }
  const withSeconds = /T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
  return `${withSeconds}${UTC_OFFSET}`;
}

function nowInManagua() {
  return new Intl.DateTimeFormat('es-NI', {
    timeZone: TIMEZONE,
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date());
}

function formatWhen(event) {
  const raw = event.start?.dateTime || event.start?.date;
  if (!raw) return 'sin fecha';
  return new Intl.DateTimeFormat('es-NI', {
    timeZone: TIMEZONE,
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(raw));
}

function simplifyEvent(e) {
  const summary = e.summary || '(sin título)';
  const startIso = e.start?.dateTime || e.start?.date;
  return {
    id: e.id,
    titulo: summary,
    vence: formatWhen(e),
    inicio_iso: startIso,
    vencida: startIso ? new Date(startIso).getTime() < Date.now() : false,
    entregada: summary.trim().startsWith(DONE_MARK),
    es_tarea_uam: (e.description || '').includes('uamvirtual-uid:'),
    descripcion: (e.description || '').replace(/uamvirtual-uid:[\d,]+/g, '').trim().slice(0, 400),
  };
}

// ─────────────────────────── Herramientas de calendario ───────────────────────────
const functionDeclarations = [
  {
    name: 'listar_tareas_uam',
    description:
      'Lista las tareas de UAM Virtual guardadas en el calendario. Por defecto trae desde hace 7 días hasta 30 días adelante, ' +
      'así que también incluye las que vencieron hace poco (campo "vencida"). ' +
      'Úsala para "qué tengo pendiente", "qué vence esta semana", "qué tengo de X clase" y también para encontrar ' +
      'la tarea que el usuario dice que ya entregó (compara por nombre de clase o tarea tú mismo).',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        desde: { type: 'string', description: 'Fecha/hora inicial (YYYY-MM-DD o YYYY-MM-DDTHH:MM). Por defecto: hace 7 días.' },
        hasta: { type: 'string', description: 'Fecha/hora final. Por defecto: 30 días desde hoy.' },
        incluir_entregadas: { type: 'boolean', description: 'Incluir las ya marcadas con ✅. Por defecto false.' },
      },
    },
  },
  {
    name: 'buscar_eventos',
    description:
      'Busca cualquier evento del calendario (no solo tareas UAM) en un rango de fechas. El texto se busca literal, ' +
      'así que usa palabras cortas o déjalo vacío y filtra tú mismo los resultados.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Texto a buscar. Vacío para traer todo el rango.' },
        desde: { type: 'string', description: 'Fecha inicial. Por defecto: hace 7 días.' },
        hasta: { type: 'string', description: 'Fecha final. Por defecto: 60 días desde hoy.' },
      },
    },
  },
  {
    name: 'marcar_entregada',
    description:
      'Marca una tarea como entregada: agrega ✅ al inicio del título y le quita los recordatorios. ' +
      'Necesita el id exacto del evento (obtenlo antes con listar_tareas_uam o buscar_eventos).',
    parametersJsonSchema: {
      type: 'object',
      properties: { event_id: { type: 'string' } },
      required: ['event_id'],
    },
  },
  {
    name: 'desmarcar_entregada',
    description: 'Quita el ✅ de una tarea marcada por error y le devuelve los recordatorios.',
    parametersJsonSchema: {
      type: 'object',
      properties: { event_id: { type: 'string' } },
      required: ['event_id'],
    },
  },
  {
    name: 'crear_evento',
    description:
      'Crea un evento o recordatorio nuevo en el calendario (por ejemplo una tarea que el usuario dicte, una reunión de grupo o un estudio). ' +
      'Confirma con el usuario la fecha y hora si no las dijo claramente.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        titulo: { type: 'string' },
        inicio: { type: 'string', description: 'YYYY-MM-DDTHH:MM en hora de Managua' },
        fin: { type: 'string', description: 'YYYY-MM-DDTHH:MM. Si no se indica, 30 minutos después del inicio.' },
        descripcion: { type: 'string' },
        recordatorios_minutos: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Minutos antes para avisar (máximo 5). Por defecto [1440, 120].',
        },
      },
      required: ['titulo', 'inicio'],
    },
  },
];

const DEFAULT_REMINDERS = [
  { method: 'popup', minutes: 2880 },
  { method: 'popup', minutes: 1440 },
  { method: 'popup', minutes: 360 },
  { method: 'popup', minutes: 120 },
  { method: 'email', minutes: 720 },
];

async function runTool(name, input) {
  const { calendar } = getClients();

  switch (name) {
    case 'listar_tareas_uam': {
      const timeMin = toRfc3339(input.desde) ||
        new Date(Date.now() - 7 * 864e5).toISOString();
      const timeMax = toRfc3339(input.hasta, true) ||
        new Date(Date.now() + 30 * 864e5).toISOString();
      const { data } = await calendar.events.list({
        calendarId: GOOGLE_CALENDAR_ID,
        timeMin, timeMax,
        q: 'uamvirtual-uid',
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 100,
        timeZone: TIMEZONE,
      });
      let items = (data.items || []).map(simplifyEvent).filter((e) => e.es_tarea_uam);
      if (!input.incluir_entregadas) items = items.filter((e) => !e.entregada);
      return { total: items.length, tareas: items };
    }

    case 'buscar_eventos': {
      const timeMin = toRfc3339(input.desde) ||
        new Date(Date.now() - 7 * 864e5).toISOString();
      const timeMax = toRfc3339(input.hasta, true) ||
        new Date(Date.now() + 60 * 864e5).toISOString();
      const { data } = await calendar.events.list({
        calendarId: GOOGLE_CALENDAR_ID,
        timeMin, timeMax,
        q: input.texto || undefined,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50,
        timeZone: TIMEZONE,
      });
      const items = (data.items || []).map(simplifyEvent);
      return { total: items.length, eventos: items };
    }

    case 'marcar_entregada': {
      const { data: ev } = await calendar.events.get({
        calendarId: GOOGLE_CALENDAR_ID, eventId: input.event_id,
      });
      const title = ev.summary || '';
      if (title.trim().startsWith(DONE_MARK)) {
        return { ok: true, mensaje: 'Ya estaba marcada como entregada.', titulo: title };
      }
      const { data: updated } = await calendar.events.patch({
        calendarId: GOOGLE_CALENDAR_ID,
        eventId: input.event_id,
        requestBody: {
          summary: `${DONE_MARK} ${title}`,
          reminders: { useDefault: false, overrides: [] },
        },
      });
      return { ok: true, titulo: updated.summary };
    }

    case 'desmarcar_entregada': {
      const { data: ev } = await calendar.events.get({
        calendarId: GOOGLE_CALENDAR_ID, eventId: input.event_id,
      });
      const title = (ev.summary || '').replace(new RegExp(`^\\s*${DONE_MARK}\\s*`), '');
      const { data: updated } = await calendar.events.patch({
        calendarId: GOOGLE_CALENDAR_ID,
        eventId: input.event_id,
        requestBody: {
          summary: title,
          reminders: { useDefault: false, overrides: DEFAULT_REMINDERS },
        },
      });
      return { ok: true, titulo: updated.summary };
    }

    case 'crear_evento': {
      const start = toRfc3339(input.inicio);
      const end = toRfc3339(input.fin) ||
        new Date(new Date(start).getTime() + 30 * 60e3).toISOString();
      const minutes = (input.recordatorios_minutos?.length ? input.recordatorios_minutos : [1440, 120]).slice(0, 5);
      const { data } = await calendar.events.insert({
        calendarId: GOOGLE_CALENDAR_ID,
        requestBody: {
          summary: input.titulo,
          description: input.descripcion || '',
          start: { dateTime: start, timeZone: TIMEZONE },
          end: { dateTime: end, timeZone: TIMEZONE },
          reminders: {
            useDefault: false,
            overrides: minutes.map((m) => ({ method: 'popup', minutes: m })),
          },
        },
      });
      return { ok: true, id: data.id, titulo: data.summary, vence: formatWhen(data) };
    }

    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}

// ─────────────────────────── Gemini ───────────────────────────
function systemPrompt() {
  return `Eres el asistente personal de Jan por WhatsApp. Ahora mismo es ${nowInManagua()} (hora de Managua).

Jan es estudiante de la UAM (Universidad Americana, Managua). Sus tareas de UAM Virtual están en su Google Calendar con títulos como "📚 [Clase] Tarea"; las entregadas empiezan con "✅". Clases: Sistemas Operativos, Programación Ágil (Jan puede decirle "ágiles" o "ágil"), PIU, entre otras.

Cómo trabajar:
- Para preguntas sobre pendientes, fechas o clases, consulta el calendario con listar_tareas_uam; nunca inventes tareas ni fechas.
- Cuando Jan diga que ya entregó o realizó algo, llama a listar_tareas_uam (sin parámetros), elige tú la tarea que coincide por clase o nombre (aunque ya esté vencida) y márcala con marcar_entregada. Confirma cuál marcaste. Solo pregunta si de verdad hay varias que coinciden.
- Al listar pendientes, ordénalas por fecha y di cuánto falta (por ejemplo "mañana 12:00 p.m., faltan 21 h"). Resalta lo que vence en menos de 24 h. Las vencidas sin ✅ menciónalas aparte como "vencidas sin marcar".
- Usa la menor cantidad posible de llamadas a herramientas.
- También puedes responder dudas generales (de clase, de estudio, explicaciones); para eso no necesitas herramientas.
- Responde en español, breve y en formato de WhatsApp: *negritas* con asteriscos, listas con "•", sin tablas ni encabezados markdown.`;
}

// Errores en los que conviene probar otro modelo (no existe, sin cuota, saturado, tardó demasiado)
const RETRYABLE = new Set([404, 408, 429, 500, 503, 504]);
let lastWorkingModel = null;            // el último modelo que respondió se prueba primero
const slowUntil = new Map();            // modelo → hasta cuándo queda al final de la fila
const noThinkingConfig = new Set();     // modelos que rechazaron la configuración de razonamiento

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.status = 408;
  }
}

// Menos "razonamiento" = respuestas mucho más rápidas. Cada familia de modelos usa un parámetro distinto.
function thinkingConfigFor(model) {
  if (noThinkingConfig.has(model)) return undefined;
  if (model.startsWith('gemini-2.5')) return { thinkingBudget: 0 };
  return { thinkingLevel: 'LOW' };
}

async function callGemini(model, request, timeoutMs) {
  const { gemini } = getClients();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const thinkingConfig = thinkingConfigFor(model);
  try {
    return await gemini.models.generateContent({
      model,
      contents: request.contents,
      config: {
        ...request.config,
        ...(thinkingConfig ? { thinkingConfig } : {}),
        abortSignal: controller.signal,
      },
    });
  } catch (err) {
    if (controller.signal.aborted) throw new TimeoutError(`${model} tardó más de ${Math.round(timeoutMs / 1000)} s`);
    // Si el modelo no acepta ese parámetro de razonamiento, se reintenta sin él una sola vez
    if (err?.status === 400 && thinkingConfig && /think/i.test(err.message || '')) {
      noThinkingConfig.add(model);
      console.warn(`${model} no acepta thinkingConfig; reintentando sin él`);
      clearTimeout(timer);
      return callGemini(model, request, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function modelOrder() {
  const now = Date.now();
  const isSlow = (m) => (slowUntil.get(m) || 0) > now;
  const base = lastWorkingModel
    ? [lastWorkingModel, ...GEMINI_MODELS.filter((m) => m !== lastWorkingModel)]
    : [...GEMINI_MODELS];
  return [...base.filter((m) => !isSlow(m)), ...base.filter(isSlow)];
}

async function generate(contents, deadline) {
  const request = {
    contents,
    config: {
      systemInstruction: systemPrompt(),
      tools: [{ functionDeclarations }],
      maxOutputTokens: 2000,
    },
  };

  const skip = new Set(); // modelos que no existen (404): no se reintentan
  let lastError = new TimeoutError('Se acabó el tiempo antes de que Gemini respondiera');

  for (let round = 0; round < 2; round++) {
    if (round > 0) {
      if (deadline - Date.now() < 8000) break;
      await sleep(2000);
    }
    for (const model of modelOrder()) {
      if (skip.has(model)) continue;
      const remaining = deadline - Date.now();
      if (remaining < 3000) throw lastError;
      const started = Date.now();
      try {
        const response = await callGemini(model, request, Math.min(GEMINI_CALL_TIMEOUT_MS, remaining));
        console.log(`Gemini ${model} respondió en ${secs(started)}`);
        lastWorkingModel = model;
        return response;
      } catch (err) {
        lastError = err;
        if (!RETRYABLE.has(err?.status)) throw err;
        if (err.status === 404) skip.add(model);
        if (err.status === 408 || err.status === 503) slowUntil.set(model, Date.now() + SLOW_MODEL_COOLDOWN_MS);
        if (lastWorkingModel === model) lastWorkingModel = null;
        console.warn(`${model} falló (${err.status}) en ${secs(started)}; probando el siguiente`);
      }
    }
  }
  throw lastError;
}

// Si Gemini se cae después de haber usado herramientas, se arma la respuesta con lo que ya se hizo.
function replyFromToolResults(toolLog) {
  const lines = [];
  for (const { name, result } of toolLog) {
    if (result?.error) continue;
    if (name === 'marcar_entregada') lines.push(`✅ Marqué como entregada: *${result.titulo.replace(/^✅\s*/, '')}*`);
    if (name === 'desmarcar_entregada') lines.push(`↩️ Quité el ✅ de: *${result.titulo}*`);
    if (name === 'crear_evento') lines.push(`📅 Creé el evento *${result.titulo}* (${result.vence})`);
  }
  if (lines.length) return lines.join('\n');

  const listing = [...toolLog].reverse().find((t) => t.name === 'listar_tareas_uam' && !t.result?.error);
  if (listing) {
    const tareas = listing.result.tareas || [];
    if (!tareas.length) return 'No tenés tareas pendientes en el calendario 🎉';
    return '*Tus pendientes:*\n' + tareas
      .map((t) => `• ${t.titulo} — ${t.vence}${t.vencida ? ' (vencida)' : ''}`)
      .join('\n');
  }
  return null;
}

// Memoria de conversación. En Vercel se conserva mientras la instancia siga viva
// (normalmente varios minutos entre mensajes seguidos); después empieza de cero.
const histories = new Map(); // número → [{role, parts}]

async function askGemini(phone, userText) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const history = histories.get(phone) || [];
  const contents = [...history, { role: 'user', parts: [{ text: userText }] }];

  let finalText = '';
  const toolLog = []; // lo que ya se hizo, por si Gemini falla al redactar la respuesta final
  for (let step = 0; step < 6; step++) {
    let response;
    try {
      response = await generate(contents, deadline);
    } catch (err) {
      const fallback = replyFromToolResults(toolLog);
      if (!fallback) throw err;
      console.warn(`Gemini falló al redactar (${err?.status || ''}); respondo con el resultado de las herramientas`);
      finalText = fallback;
      break;
    }

    // Se guarda la respuesta completa del modelo (incluye las firmas de razonamiento que Gemini pide reenviar)
    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);

    const calls = response.functionCalls || [];
    if (!calls.length) {
      finalText = (response.text || '').trim();
      if (!finalText) {
        console.warn('Gemini respondió vacío. finishReason:', response.candidates?.[0]?.finishReason);
      }
      break;
    }

    const parts = [];
    for (const call of calls) {
      const started = Date.now();
      let result;
      try {
        result = await runTool(call.name, call.args || {});
        console.log(`Herramienta ${call.name} ${JSON.stringify(call.args || {})} OK en ${secs(started)}`);
      } catch (err) {
        console.error(`Error en ${call.name} (${secs(started)}):`, err.message);
        result = { error: err.message };
      }
      toolLog.push({ name: call.name, result });
      parts.push({
        functionResponse: {
          id: call.id,
          name: call.name,
          response: result?.error ? { error: result.error } : { output: result },
        },
      });
    }
    contents.push({ role: 'user', parts });
  }

  if (!finalText) finalText = replyFromToolResults(toolLog) ||
    'No pude completar eso, ¿lo intentas de nuevo con otras palabras?';

  // Solo guardamos texto (sin llamadas a herramientas) para que el historial sea válido y liviano.
  histories.set(phone, [
    ...history,
    { role: 'user', parts: [{ text: userText }] },
    { role: 'model', parts: [{ text: finalText }] },
  ].slice(-MAX_HISTORY));

  return finalText;
}

// ─────────────────────────── WhatsApp ───────────────────────────
async function sendWhatsApp(to, text) {
  const { whatsapp } = getClients();
  const started = Date.now();
  // WhatsApp acepta hasta 4096 caracteres por mensaje
  for (let i = 0; i < text.length; i += 4000) {
    await whatsapp.messages.sendText({
      phoneNumberId: env.KAPSO_PHONE_NUMBER_ID,
      to,
      body: text.slice(i, i + 4000),
    });
  }
  console.log(`Mensaje enviado por Kapso en ${secs(started)}`);
}

function extractEvents(body) {
  // Kapso puede enviar un evento o un lote
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body)) return body;
  return [body];
}

const seen = new Set();
function alreadyProcessed(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 1000) seen.delete(seen.values().next().value);
  return false;
}

async function handleIncoming(evt) {
  const msg = evt?.message;
  if (!msg) return;
  if (msg.kapso?.direction && msg.kapso.direction !== 'inbound') return;
  if (alreadyProcessed(msg.id)) return;

  const from = onlyDigits(evt.conversation?.phone_number || msg.from);
  if (from !== onlyDigits(env.ALLOWED_NUMBER)) {
    console.log(`Mensaje ignorado de ${from}`);
    return;
  }

  const text = msg.text?.body || msg.kapso?.content;
  if (!text || msg.type !== 'text') {
    await sendWhatsApp(from, 'Por ahora solo entiendo mensajes de texto 🙂');
    return;
  }

  console.log(`← ${from}: ${text}`);
  const started = Date.now();
  let reply;
  try {
    reply = await askGemini(from, text);
    console.log(`→ ${from} (${secs(started)}): ${reply.slice(0, 120)}…`);
  } catch (err) {
    console.error(`Error procesando mensaje (${secs(started)}):`, err?.status || '', err?.message || err);
    const reasons = {
      408: 'Gemini tardó demasiado en responder. Intenta de nuevo en un momento.',
      429: 'Se agotó la cuota gratuita de Gemini por ahora. Intenta en un rato (se renueva cada día).',
      503: 'Gemini está saturado en este momento. Intenta de nuevo en un par de minutos.',
    };
    reply = reasons[err?.status] || 'Tuve un error procesando tu mensaje. Intenta de nuevo en un momento.';
  }

  try {
    await sendWhatsApp(from, reply);
  } catch (err) {
    console.error('Error enviando por Kapso:', err?.status || '', err?.message || err);
  }
}

/**
 * Procesa un webhook de Kapso. Devuelve una promesa con todo el trabajo pendiente
 * para que quien llama responda 200 de inmediato y espere esta promesa aparte.
 * @param {object} body  JSON recibido
 * @param {(name: string) => string | null} getHeader
 */
export function processWebhook(body, getHeader) {
  const eventType = getHeader('x-webhook-event');
  if (eventType && eventType !== 'whatsapp.message.received') return Promise.resolve();
  if (alreadyProcessed(getHeader('x-idempotency-key'))) return Promise.resolve();

  return Promise.all(
    extractEvents(body).map((evt) => handleIncoming(evt).catch((err) => console.error(err))),
  );
}
