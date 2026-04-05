import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { Client } from 'ssh2';
import { randomBytes, createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 3100;
const TOKEN_SECRET = process.env.TOKEN_SECRET || randomBytes(32).toString('hex');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);

// In-memory store for private keys (short-lived, cleared on restart)
const keyStore = new Map();

function isOriginAllowed(origin) {
  if (!origin || ALLOWED_ORIGINS.length === 0) return true;
  return ALLOWED_ORIGINS.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const domain = pattern.slice(1); // ".example.com"
      return origin.endsWith(domain) || origin === `https://${pattern.slice(2)}`;
    }
    return origin === pattern || origin === `https://${pattern}`;
  });
}

// Token format: base64(json{host,port,user,exp,sig})
// No credentials stored on this server - everything in the token

function generateToken(host, port, user, password, ttlMinutes = 30, command = '', useKey = false) {
  const exp = Date.now() + ttlMinutes * 60 * 1000;
  const payload = { host, port, user, password, exp, command, useKey };
  const data = JSON.stringify(payload);
  const sig = createHmac('sha256', TOKEN_SECRET).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ ...payload, sig })).toString('base64url');
}

function verifyToken(token) {
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString());
    const { sig, ...payload } = decoded;
    const expectedSig = createHmac('sha256', TOKEN_SECRET).update(JSON.stringify(payload)).digest('hex');
    if (sig !== expectedSig) return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// API: Generate token (called by mobilencoderadmin Worker)
app.use(express.json());

app.post('/api/token', (req, res) => {
  const authHeader = req.headers['x-api-key'];
  if (authHeader !== TOKEN_SECRET) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  const { host, port, user, password, privateKey, useKey, ttl, command } = req.body;
  if (!host || !user || (!password && !privateKey && !useKey)) {
    return res.status(400).json({ error: 'host, user, and password/privateKey/useKey required' });
  }

  // If privateKey provided, store it temporarily and pass keyId in token
  if (privateKey) {
    const keyId = randomBytes(16).toString('hex');
    keyStore.set(keyId, { key: privateKey, expires: Date.now() + (ttl || 30) * 60 * 1000 });
    const token = generateToken(host, port || 22, user, '', ttl || 30, command || '', keyId);
    const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
    return res.json({ token, url: `${baseUrl}/?token=${token}` });
  }

  // useKey='default' means use the server's default SSH key file
  const token = generateToken(host, port || 22, user, password || '', ttl || 30, command || '', useKey || false);
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
  return res.json({ token, url: `${baseUrl}/?token=${token}` });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static files (xterm.js frontend)
app.use(express.static(join(__dirname, '../public')));

// WebSocket: SSH proxy
wss.on('connection', (ws, req) => {
  // Check origin
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin)) {
    ws.close(4003, 'Origin not allowed');
    return;
  }

  // Get token from URL
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(4001, 'Token required');
    return;
  }

  const credentials = verifyToken(token);
  if (!credentials) {
    ws.close(4002, 'Invalid or expired token');
    return;
  }

  console.log(`SSH connecting: ${credentials.user}@${credentials.host}:${credentials.port} useKey=${credentials.useKey} hasPassword=${!!credentials.password}`);

  const ssh = new Client();
  let stream = null;

  ssh.on('ready', () => {
    ws.send(JSON.stringify({ type: 'status', message: 'connected' }));

    ssh.shell({ term: 'xterm-256color', cols: 120, rows: 40 }, (err, s) => {
      if (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
        ws.close();
        return;
      }

      stream = s;

      // Auto-run command if provided
      if (credentials.command) {
        setTimeout(() => {
          s.write(credentials.command + '\n');
        }, 500);
      }

      s.on('data', (data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data: data.toString('base64') }));
        }
      });

      s.on('close', () => {
        ws.close();
      });

      s.stderr.on('data', (data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data: data.toString('base64') }));
        }
      });
    });
  });

  ssh.on('error', (err) => {
    console.error('SSH error:', err.message);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
    ws.close();
  });

  ssh.on('close', () => {
    if (ws.readyState === ws.OPEN) {
      ws.close();
    }
  });

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);

      if (parsed.type === 'data' && stream) {
        stream.write(Buffer.from(parsed.data, 'base64'));
      }

      if (parsed.type === 'resize' && stream) {
        stream.setWindow(parsed.rows, parsed.cols, 0, 0);
      }
    } catch {
      // Raw data fallback
      if (stream) stream.write(msg);
    }
  });

  ws.on('close', () => {
    if (stream) stream.close();
    ssh.end();
  });

  // Connect SSH
  const connectOpts = {
    host: credentials.host,
    port: credentials.port,
    username: credentials.user,
    readyTimeout: 10000,
    keepaliveInterval: 10000,
  };

  // Check if useKey points to a stored private key or use default key file
  if (credentials.useKey) {
    if (keyStore.has(credentials.useKey)) {
      const stored = keyStore.get(credentials.useKey);
      if (stored.expires > Date.now()) {
        connectOpts.privateKey = stored.key;
      } else {
        keyStore.delete(credentials.useKey);
      }
    } else if (credentials.useKey === 'default' && process.env.SSH_DEFAULT_KEY_PATH) {
      try {
        connectOpts.privateKey = readFileSync(process.env.SSH_DEFAULT_KEY_PATH, 'utf8');
      } catch (e) {
        console.error('Failed to read default SSH key:', e.message);
      }
    }
  }
  console.log('connectOpts hasPrivateKey:', !!connectOpts.privateKey, 'hasPassword:', !!connectOpts.password);
  if (credentials.password) {
    connectOpts.password = credentials.password;
  }

  ssh.connect(connectOpts);
});

server.listen(PORT, () => {
  console.log(`SSH Service running on port ${PORT}`);
});
