require('./patch-wwebjs'); // must run before whatsapp-web.js is loaded
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const cfg = require('./config');
const store = require('./store');
const wa = require('./whatsapp');
const scheduler = require('./scheduler');

if (!cfg.DASHBOARD_PASSWORD || cfg.DASHBOARD_PASSWORD.length < 8) {
  console.error('Set DASHBOARD_PASSWORD (at least 8 characters) in your .env before starting.');
  process.exit(1);
}

fs.mkdirSync(cfg.UPLOAD_DIR, { recursive: true });
store.load();

const app = express();
app.disable('x-powered-by');

// ---- Basic auth for everything ----
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
app.use((req, res, next) => {
  const [type, value] = (req.headers.authorization || '').split(' ');
  if (type === 'Basic' && value) {
    const decoded = Buffer.from(value, 'base64').toString();
    const i = decoded.indexOf(':');
    const user = decoded.slice(0, i);
    const pass = decoded.slice(i + 1);
    if (i > -1 && safeEqual(user, cfg.DASHBOARD_USER) & safeEqual(pass, cfg.DASHBOARD_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Group Scheduler"').status(401).send('Login required');
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: cfg.UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname || '')),
  }),
  limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024 },
});

// ---- API ----
app.get('/api/status', (_req, res) => {
  const { status, qrDataUrl, me, lastError } = wa.state;
  res.json({ status, qr: qrDataUrl, me, lastError, groupFilter: cfg.GROUP_FILTER });
});

app.get('/api/groups', async (req, res) => {
  try {
    res.json(await wa.getGroups({ fresh: req.query.fresh === '1', type: req.query.type }));
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

app.get('/api/schedules', (_req, res) => {
  res.json(store.all().map(({ media, ...j }) => ({
    ...j,
    media: media ? { name: media.originalName, size: media.size, mimeType: media.mimeType } : null,
  })));
});

app.post('/api/schedules', upload.single('media'), async (req, res) => {
  const cleanup = () => req.file && fs.rm(req.file.path, { force: true }, () => {});
  try {
    const message = String(req.body.message || '').trim();
    const sendAt = new Date(req.body.sendAt);
    let groupIds = req.body.groupIds || [];
    if (!Array.isArray(groupIds)) groupIds = [groupIds];

    if (!message && !req.file) throw new Error('Add a message or an attachment');
    if (isNaN(sendAt)) throw new Error('Pick a valid date and time');
    if (sendAt.getTime() < Date.now() - 60_000) throw new Error('That time is in the past');
    if (!groupIds.length) throw new Error('Select at least one group');

    const chosen = await Promise.all(groupIds.map(id => wa.findAllowed(id)));
    if (chosen.some(g => !g)) throw new Error('One of the selected groups is not one you own');

    const media = req.file
      ? { path: req.file.path, originalName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size }
      : null;

    const created = chosen.map(g =>
      store.add({ groupId: g.id, groupName: g.name, message, sendAt: sendAt.toISOString(), media })
    );
    res.status(201).json({ created: created.length });
  } catch (e) {
    cleanup();
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/schedules/:id/send-now', (req, res) => {
  const j = store.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  if (j.status === 'sent' || j.status === 'sending') return res.status(400).json({ error: 'Already sent' });
  store.update(j.id, { status: 'pending', sendAt: new Date().toISOString(), error: null });
  scheduler.tick().catch(() => {});
  res.json({ ok: true });
});

app.delete('/api/schedules/:id', (req, res) => {
  const j = store.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  if (j.status === 'sending') return res.status(409).json({ error: 'Sending right now — try again in a moment' });
  store.remove(j.id);
  if (j.media && !store.mediaInUse(j.media.path)) fs.rm(j.media.path, { force: true }, () => {});
  res.json({ ok: true });
});

app.post('/api/logout', async (_req, res) => {
  await wa.logout();
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${cfg.MAX_UPLOAD_MB} MB` : err.message;
  res.status(400).json({ error: msg });
});

app.listen(cfg.PORT, () => console.log(`Dashboard on http://localhost:${cfg.PORT}`));

if (process.env.NO_WHATSAPP !== '1') wa.start();
scheduler.start();
