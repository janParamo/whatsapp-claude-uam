# Asistente de WhatsApp para tareas UAM (Kapso + Gemini + Google Calendar)

## Enlaces para configurarlo

**Kapso (WhatsApp):**
- Crear cuenta y proyecto: https://app.kapso.ai
- Conectar un número: https://docs.kapso.ai/docs/whatsapp/personal-agent
- Webhooks: https://docs.kapso.ai/docs/platform/webhooks/overview

**Gemini (API key gratis):**
- Crear API key: https://aistudio.google.com/apikey
- Límites gratuitos y modelos disponibles: https://aistudio.google.com/rate-limit

**Google Calendar (OAuth):**
- Activar Calendar API: https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
- Pantalla de consentimiento: https://console.cloud.google.com/auth/overview
- Crear ID de cliente (tipo *Aplicación de escritorio*): https://console.cloud.google.com/apis/credentials
- Después: `npm install` y `npm run token` para obtener `GOOGLE_REFRESH_TOKEN`

**Vercel (hosting gratis):**
- Crear cuenta (plan Hobby): https://vercel.com/signup
- Importar el repo de GitHub: https://vercel.com/new
- Variables de entorno: https://vercel.com/docs/environment-variables

**GitHub (repo privado):** https://github.com/new

## Datos que vas a necesitar

| Dónde | Valor |
|---|---|
| Vercel → Environment Variables | Todas las de `.env.example`, excepto `PORT` |
| Kapso → webhook `whatsapp.message.received` | `https://TU-PROYECTO.vercel.app/api/webhook?key=TU_WEBHOOK_SECRET` |
| Comprobar que está bien | Abrir `https://TU-PROYECTO.vercel.app/api/webhook` → `{"ok":true}` |
