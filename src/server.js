import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { Client, LocalAuth } from 'whatsapp-web.js';
import QRCode from 'qrcode';

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

app.use(cors());
app.use(express.json());

const sessions = new Map();

app.get('/health', (req, res) => {
  res.json({ status: 'online', timestamp: new Date().toISOString() });
});

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.partner_id = decoded.partner_id;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

app.post('/api/sessions/init', authenticate, async (req, res) => {
  const { partner_id } = req;
  try {
    if (sessions.has(partner_id)) {
      const oldClient = sessions.get(partner_id);
      await oldClient.destroy().catch(() => {});
      sessions.delete(partner_id);
    }

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: partner_id }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      }
    });

    let qrCodeSent = false;

    client.on('qr', async (qr) => {
      if (!qrCodeSent) {
        const qrDataURL = await QRCode.toDataURL(qr);
        res.json({ qr_code: qrDataURL, expires_in: 60 });
        qrCodeSent = true;
      }
    });

    client.on('ready', () => {
      sessions.set(partner_id, client);
    });

    client.on('disconnected', () => {
      sessions.delete(partner_id);
    });

    await client.initialize();

    setTimeout(() => {
      if (!qrCodeSent) res.status(408).json({ error: 'QR timeout' });
    }, 30000);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/status', authenticate, async (req, res) => {
  const client = sessions.get(req.partner_id);
  if (!client) return res.json({ status: 'disconnected' });
  try {
    const state = await client.getState();
    res.json({ status: state === 'CONNECTED' ? 'connected' : 'disconnected' });
  } catch (error) {
    res.json({ status: 'disconnected' });
  }
});

app.post('/api/sessions/disconnect', authenticate, async (req, res) => {
  const client = sessions.get(req.partner_id);
  if (!client) return res.json({ success: false });
  await client.destroy();
  sessions.delete(req.partner_id);
  res.json({ success: true });
});

app.post('/api/messages/send', authenticate, async (req, res) => {
  const client = sessions.get(req.partner_id);
  if (!client) return res.status(400).json({ error: 'No session' });
  const chatId = req.body.phone.includes('@c.us') ? req.body.phone : `${req.body.phone}@c.us`;
  await client.sendMessage(chatId, req.body.message);
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`Gateway on port ${PORT}`));
