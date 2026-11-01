// WhatsApp connection via whatsapp-web.js (links like WhatsApp Web, using a QR code).
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const cfg = require('./config');

const state = {
  status: 'starting', // starting | qr | authenticated | ready | disconnected | auth_failure
  qrDataUrl: null,
  me: null,           // { id, number, name }
  lastError: null,
};

const myIds = new Set(); // all ids that represent "me" (phone id and LID, if known)
let groupCache = { at: 0, groups: [] };
let client;

function clearChromeLocks() {
  // A crashed/killed container can leave Chromium lock files that block the next start.
  const dir = path.join(cfg.SESSION_DIR, 'session');
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch (_) {}
  }
}

function build() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: cfg.SESSION_DIR }),
    puppeteer: {
      headless: true,
      executablePath: cfg.CHROME_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  });

  client.on('qr', async qr => {
    state.status = 'qr';
    state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
    console.log('[wa] QR code ready — open the dashboard to scan it');
  });

  client.on('authenticated', () => {
    state.status = 'authenticated';
    state.qrDataUrl = null;
    console.log('[wa] authenticated');
  });

  client.on('ready', async () => {
    const wid = client.info.wid;
    state.me = { id: wid._serialized, number: wid.user, name: client.info.pushname || '' };
    myIds.clear();
    myIds.add(wid._serialized);
    // Newer WhatsApp versions identify group members by LID instead of phone number.
    try {
      if (typeof client.getContactLidAndPhone === 'function') {
        const [info] = await client.getContactLidAndPhone([wid._serialized]);
        if (info && info.lid) myIds.add(info.lid);
      }
    } catch (_) {}
    await applyCompatPatch();
    try {
      const lid = await client.pupPage.evaluate(() => {
        const u = window.Store && window.Store.User;
        const l = u && u.getMaybeMeLidUser && u.getMaybeMeLidUser();
        return l ? l.toString() : null;
      });
      if (lid) myIds.add(lid);
    } catch (_) {}
    groupCache = { at: 0, groups: [] };
    state.status = 'ready';
    state.lastError = null;
    console.log(`[wa] ready as +${wid.user}`);
  });

  client.on('auth_failure', msg => {
    state.status = 'auth_failure';
    state.lastError = String(msg);
    console.error('[wa] auth failure:', msg);
  });

  client.on('disconnected', async reason => {
    state.status = 'disconnected';
    state.lastError = String(reason);
    console.warn('[wa] disconnected:', reason, '— restarting in 10s');
    try { await client.destroy(); } catch (_) {}
    setTimeout(start, 10_000);
  });
}

async function start() {
  clearChromeLocks();
  build();
  state.status = 'starting';
  try {
    await client.initialize();
  } catch (e) {
    state.status = 'disconnected';
    state.lastError = e.message;
    console.error('[wa] failed to start:', e.message, '— retrying in 30s');
    try { await client.destroy(); } catch (_) {}
    setTimeout(start, 30_000);
  }
}

// Workaround for a WhatsApp Web update (2.3000.x) that renamed the internal `_serialized`
// field on message keys to `$1`, which breaks whatsapp-web.js getChats() ("r: r") and
// media sending ("t: t"). Safe to run repeatedly; harmless once the library is fixed.
async function applyCompatPatch() {
  try {
    await client.pupPage.evaluate(() => {
      const p = window.Store && window.Store.MsgKey && window.Store.MsgKey.prototype;
      if (p && !('_serialized' in p)) {
        Object.defineProperty(p, '_serialized', {
          get() { return this.$1; },
          configurable: true,
        });
      }
    });
  } catch (e) {
    console.warn('[wa] compatibility patch skipped:', e.message);
  }
}

const idStr = id => (!id ? '' : typeof id === 'string' ? id : id._serialized || String(id));

function isMe(id) {
  const s = idStr(id);
  if (!s) return false;
  if (myIds.has(s)) return true;
  // Fallback: compare the number part when the id is a phone-style id.
  const [user, server] = s.split('@');
  return (server === 'c.us' || server === 's.whatsapp.net') && !!state.me && user === state.me.number;
}

function groupAllowed(g) {
  if (cfg.GROUP_FILTER === 'all') return true;
  const mine = g.participants.find(p => isMe(p.id));
  if (isMe(g.owner) || (mine && mine.isSuperAdmin)) return true;
  return cfg.GROUP_FILTER === 'admin' && !!(mine && mine.isAdmin);
}

// Read groups straight from WhatsApp Web's chat list (avoids the broken getChats()).
async function readGroupsDirect() {
  return client.pupPage.evaluate(() => {
    const str = w => (w ? w.toString() : null);
    const Store = window.Store || {};
    const Chat = Store.Chat || window.require('WAWebCollections').Chat;
    const partsOf = meta => {
      const p = meta && meta.participants;
      if (!p) return [];
      const arr = p.getModelsArray ? p.getModelsArray() : p;
      return arr.map(x => ({ id: str(x.id), isAdmin: !!x.isAdmin, isSuperAdmin: !!x.isSuperAdmin }));
    };
    const describe = meta => meta && ({
      name: meta.subject || '',
      owner: str(meta.owner),
      participants: partsOf(meta),
    });
    return Chat.getModelsArray()
      .filter(c => c.id && str(c.id).endsWith('@g.us'))
      .map(c => {
        const meta = c.groupMetadata;
        // Communities: the parent "community" can't be posted to; its Announcements
        // group can. Ownership of a community lives on the parent, so include it.
        const parentId = meta && meta.parentGroup ? str(meta.parentGroup) : null;
        let parent = null;
        if (parentId) {
          try {
            const pm = (Store.GroupMetadata && Store.GroupMetadata.get(parentId)) ||
                       (Chat.get(parentId) && Chat.get(parentId).groupMetadata);
            parent = describe(pm);
          } catch (_) {}
        }
        return {
          id: str(c.id),
          name: c.name || c.formattedTitle || (meta && meta.subject) || '',
          owner: meta ? str(meta.owner) : null,
          participants: partsOf(meta),
          isCommunity: !!(meta && meta.isParentGroup),
          isAnnouncement: !!(meta && (meta.defaultSubgroup || meta.isCommunityAnnounce)),
          parentId,
          parent,
        };
      });
  });
}

async function readGroupsViaLibrary() {
  const chats = await client.getChats();
  return chats
    .filter(c => idStr(c.id).endsWith('@g.us'))
    .map(c => ({
      id: idStr(c.id),
      name: c.name || '',
      owner: idStr(c.owner) || null,
      participants: (c.participants || []).map(p => ({ id: idStr(p.id), isAdmin: !!p.isAdmin, isSuperAdmin: !!p.isSuperAdmin })),
    }));
}

// Groups you're allowed to schedule to, cached for 60s (reading chats is slow).
async function getGroups({ fresh = false } = {}) {
  if (state.status !== 'ready') throw new Error('WhatsApp is not connected yet');
  if (!fresh && Date.now() - groupCache.at < 60_000) return groupCache.groups;
  await applyCompatPatch();
  let raw;
  try {
    raw = await readGroupsDirect();
  } catch (e) {
    console.warn('[wa] direct group read failed, trying library:', e.message);
    raw = await readGroupsViaLibrary();
  }
  const byId = new Map(raw.map(g => [g.id, g]));
  const groups = [];
  for (const g of raw) {
    if (g.isCommunity) continue; // the community "shell" itself can't receive messages
    const parent = g.parentId ? (byId.get(g.parentId) || g.parent) : null;
    if (g.isAnnouncement && parent) {
      // Community announcements: allowed if you own (or, per filter, admin) the community.
      if (!groupAllowed(parent) && !groupAllowed(g)) continue;
      groups.push({
        id: g.id,
        name: `${parent.name || g.name || 'Community'} · Announcements`,
        participants: g.participants.length,
        owner: isMe(parent.owner) || isMe(g.owner),
        community: true,
      });
      continue;
    }
    if (!groupAllowed(g)) continue;
    groups.push({
      id: g.id,
      name: g.name || '(unnamed group)',
      participants: g.participants.length,
      owner: isMe(g.owner),
      community: false,
    });
  }
  groups.sort((a, b) => (b.community - a.community) || a.name.localeCompare(b.name));
  const nComm = raw.filter(g => g.isCommunity).length;
  const nAnn = raw.filter(g => g.isAnnouncement).length;
  console.log(`[wa] ${raw.length} groups found (${nComm} communities, ${nAnn} announcement groups), ` +
              `${groups.length} allowed (GROUP_FILTER=${cfg.GROUP_FILTER})`);
  groupCache = { at: Date.now(), groups };
  return groups;
}

async function sendToGroup(groupId, text, media) {
  if (state.status !== 'ready') throw new Error('WhatsApp is not connected');
  // Safety check: never send to a group outside the allowed set.
  const groups = await getGroups();
  if (!groups.some(g => g.id === groupId)) {
    throw new Error('Group is not one you own (or you are no longer in it)');
  }
  await applyCompatPatch();
  if (media) {
    if (!fs.existsSync(media.path)) throw new Error('Attachment file is missing on the server');
    const m = MessageMedia.fromFilePath(media.path);
    m.filename = media.originalName || m.filename;
    if (media.mimeType) m.mimetype = media.mimeType;
    const isVisual = /^(image|video)\//.test(m.mimetype || '');
    await client.sendMessage(groupId, m, {
      caption: text || undefined,
      sendMediaAsDocument: !isVisual,
    });
  } else {
    await client.sendMessage(groupId, text);
  }
}

async function logout() {
  client.removeAllListeners('disconnected'); // we restart ourselves below
  try { await client.logout(); } catch (_) {}
  try { await client.destroy(); } catch (_) {}
  state.status = 'starting';
  state.me = null;
  groupCache = { at: 0, groups: [] };
  setTimeout(start, 2000); // comes back up showing a fresh QR code
}

module.exports = { state, start, getGroups, sendToGroup, logout };
