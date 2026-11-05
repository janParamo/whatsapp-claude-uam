// Obtiene el refresh token de Google Calendar una sola vez.
// Uso: completa GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en .env y corre `npm run token`.
import 'dotenv/config';
import http from 'node:http';
import { google } from 'googleapis';

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Falta GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET en .env');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/calendar.events'],
});

console.log('\n1) Abre este enlace en tu navegador e inicia sesión con la cuenta del calendario:\n');
console.log(authUrl);
console.log('\n2) Acepta los permisos. Esta ventana mostrará el refresh token.\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('No llegó el código de autorización.');
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Listo. Vuelve a la terminal y copia el refresh token en tu .env.');
    console.log('\nGOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
    if (!tokens.refresh_token) {
      console.log('No vino refresh token. Quita el acceso de la app en https://myaccount.google.com/permissions y repite.');
    }
  } catch (err) {
    res.writeHead(500).end('Error obteniendo el token: ' + err.message);
    console.error(err);
  } finally {
    server.close();
  }
});

server.listen(PORT);
