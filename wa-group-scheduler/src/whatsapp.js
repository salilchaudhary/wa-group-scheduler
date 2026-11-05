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
let groupCache;
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
      protocolTimeout: 300_000, // default 180s is too short for very large accounts
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
    badChecks = 0;
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
    resetGroupCache();
    state.status = 'ready';
    state.lastError = null;
    console.log(`[wa] ready as +${wid.user}`);
  });

  client.on('auth_failure', msg => {
    state.status = 'auth_failure';
    state.lastError = String(msg);
    console.error('[wa] auth failure:', msg);
  });

  client.on('disconnected', reason => {
    const loggedOut = reason === 'LOGOUT' || reason === 'UNPAIRED' || reason === 'UNPAIRED_IDLE';
    restart(String(reason), { clearSession: loggedOut, delayMs: 10_000 });
  });
}

let generation = 0;     // bumps on every (re)start so stale timers/handlers do nothing
let restarting = false;
let statusSince = Date.now();
let lastStatus = null;

function clearSession() {
  try { fs.rmSync(cfg.SESSION_DIR, { recursive: true, force: true }); } catch (_) {}
}

async function start() {
  const gen = ++generation;
  restarting = false;
  clearChromeLocks();
  build();
  state.status = 'starting';
  state.me = null;
  state.qrDataUrl = null;
  try {
    await client.initialize();
  } catch (e) {
    if (gen !== generation) return;
    console.error('[wa] failed to start:', e.message);
    restart(e.message, { delayMs: 30_000 });
  }
}

// Tear down Chrome and start again. clearSession forces a fresh QR code.
async function restart(reason, { clearSession: wipe = false, delayMs = 3000 } = {}) {
  if (restarting) return;
  restarting = true;
  generation++; // invalidate the old client's pending work
  state.status = 'disconnected';
  state.lastError = reason;
  state.me = null;
  resetGroupCache();
  console.warn(`[wa] restarting (${reason})${wipe ? ' — logged out, a new QR code will be shown' : ''}`);
  const old = client;
  if (old) {
    old.removeAllListeners();
    try { await withTimeout(old.destroy(), 20_000); } catch (_) {}
  }
  if (wipe) clearSession();
  setTimeout(start, delayMs);
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
}

// Health check: the library's own logout event doesn't always fire on current WhatsApp Web,
// so ask the page directly every minute and recover if the link is gone or Chrome is stuck.
let badChecks = 0;
async function healthCheck() {
  if (restarting) return;
  if (state.status !== lastStatus) { lastStatus = state.status; statusSince = Date.now(); }

  // Stuck while starting up or loading chats for too long → restart (keeps the login).
  if (['starting', 'authenticated'].includes(state.status) && Date.now() - statusSince > 6 * 60_000) {
    return restart(`stuck on "${state.status}" for 6 minutes`);
  }
  if (state.status !== 'ready' || readingGroups) return;

  let ws = null;
  try {
    ws = await withTimeout(client.pupPage.evaluate(() => {
      try { return window.require('WAWebSocketModel').Socket.state || null; } catch (_) { return 'UNKNOWN'; }
    }), 20_000);
  } catch (e) {
    ws = 'NO_RESPONSE';
  }

  if (ws === 'UNPAIRED' || ws === 'UNPAIRED_IDLE') {
    badChecks = 0;
    return restart('WhatsApp was unlinked from the phone', { clearSession: true });
  }
  if (ws === 'CONNECTED') { badChecks = 0; return; }
  if (ws === 'UNKNOWN') return; // WhatsApp renamed its internals; can't tell, so don't act on it

  badChecks++;
  console.warn(`[wa] health check: connection state is ${ws} (${badChecks}/3)`);
  if (badChecks >= 3) {
    badChecks = 0;
    restart(`connection state stayed ${ws} for 3 minutes`);
  }
}
setInterval(() => healthCheck().catch(e => console.error('[wa] health check error:', e.message)), 60_000);

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
  const mine = g.me;
  if (isMe(g.owner) || (mine && mine.isSuperAdmin)) return true;
  return cfg.GROUP_FILTER === 'admin' && !!(mine && mine.isAdmin);
}

// Read groups straight from WhatsApp Web's chat list (avoids the broken getChats()).
// Everything is worked out inside the page and only a small summary per group comes back:
// copying every member of thousands of groups out of the browser is what made it time out.
async function readGroupsDirect(type) {
  const me = { ids: [...myIds], number: state.me ? state.me.number : null, type };
  return client.pupPage.evaluate(me => {
    const myIdSet = new Set(me.ids);
    const str = w => (w ? w.toString() : null);
    const isMe = w => {
      const s = str(w);
      if (!s) return false;
      if (myIdSet.has(s)) return true;
      const [user, server] = s.split('@');
      return (server === 'c.us' || server === 's.whatsapp.net') && !!me.number && user === me.number;
    };
    const Store = window.Store || {};
    const Chat = Store.Chat || window.require('WAWebCollections').Chat;
    const summary = meta => {
      const p = meta && meta.participants;
      const arr = !p ? [] : (p.getModelsArray ? p.getModelsArray() : p);
      const mine = arr.find(x => isMe(x.id));
      return {
        owner: meta ? str(meta.owner) : null,
        count: arr.length,
        me: mine ? { isAdmin: !!mine.isAdmin, isSuperAdmin: !!mine.isSuperAdmin } : null,
      };
    };
    const out = [];
    for (const c of Chat.getModelsArray()) {
      try {
        const id = str(c.id);
        if (!id || !id.endsWith('@g.us')) continue;
        const meta = c.groupMetadata;
        const isCommunity = !!(meta && meta.isParentGroup);
        const isAnnouncement = !!(meta && (meta.defaultSubgroup || meta.isCommunityAnnounce));
        // Only do the (slower) member lookup for the category that was asked for.
        if (me.type === 'communities' ? !(isCommunity || isAnnouncement) : (isCommunity || isAnnouncement)) continue;
        // Communities: the parent "community" can't be posted to; its Announcements
        // group can. Ownership of a community lives on the parent, so include it.
        const parentId = meta && meta.parentGroup ? str(meta.parentGroup) : null;
        let parent = null;
        if (parentId) {
          try {
            const pm = (Store.GroupMetadata && Store.GroupMetadata.get(parentId)) ||
                       (Chat.get(parentId) && Chat.get(parentId).groupMetadata);
            if (pm) parent = { name: pm.subject || '', ...summary(pm) };
          } catch (_) {}
        }
        out.push({
          id,
          name: c.name || c.formattedTitle || (meta && meta.subject) || '',
          ...summary(meta),
          isCommunity,
          isAnnouncement,
          parentId,
          parent,
        });
      } catch (_) { /* skip a chat WhatsApp can't describe rather than failing the whole list */ }
    }
    return out;
  }, me);
}

async function readGroupsViaLibrary() {
  const chats = await client.getChats();
  return chats
    .filter(c => idStr(c.id).endsWith('@g.us'))
    .map(c => {
      const parts = c.participants || [];
      const mine = parts.find(p => isMe(p.id));
      return {
        id: idStr(c.id),
        name: c.name || '',
        owner: idStr(c.owner) || null,
        count: parts.length,
        me: mine ? { isAdmin: !!mine.isAdmin, isSuperAdmin: !!mine.isSuperAdmin } : null,
      };
    });
}

const GROUP_CACHE_MS = 10 * 60_000; // re-read at most every 10 minutes (or on "Refresh")
const TYPES = ['groups', 'communities'];
const inFlight = {};                 // share one read between callers asking at the same time
let readingGroups = false;

function resetGroupCache() { groupCache = { groups: { at: 0, list: [] }, communities: { at: 0, list: [] } }; }
resetGroupCache();

// Groups you're allowed to schedule to, for one category: 'groups' or 'communities'.
async function getGroups({ fresh = false, type = 'groups' } = {}) {
  if (!TYPES.includes(type)) type = 'groups';
  if (state.status !== 'ready') throw new Error('WhatsApp is not connected yet');
  const c = groupCache[type];
  if (!fresh && c.at && Date.now() - c.at < GROUP_CACHE_MS) return c.list;
  if (!inFlight[type]) inFlight[type] = loadGroups(type).finally(() => { inFlight[type] = null; });
  return inFlight[type];
}

// Find an allowed group/community by id, checking whichever lists are needed.
async function findAllowed(groupId) {
  for (const type of TYPES) {
    const c = groupCache[type];
    const hit = c.at && c.list.find(g => g.id === groupId);
    if (hit) return hit;
  }
  for (const type of TYPES) {
    const hit = (await getGroups({ type })).find(g => g.id === groupId);
    if (hit) return hit;
  }
  return null;
}

async function loadGroups(type) {
  readingGroups = true;
  const t0 = Date.now();
  try {
    await applyCompatPatch();
    let raw;
    try {
      raw = await readGroupsDirect(type);
    } catch (e) {
      // The library route is far slower; only try it if the fast route broke for another reason.
      if (/timed out|timeout/i.test(e.message)) throw new Error('WhatsApp is taking too long to list groups — try Refresh in a minute');
      console.warn('[wa] direct group read failed, trying library:', e.message);
      raw = type === 'groups' ? await readGroupsViaLibrary() : [];
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
          participants: g.count,
          owner: isMe(parent.owner) || isMe(g.owner),
          community: true,
        });
        continue;
      }
      if (!groupAllowed(g)) continue;
      groups.push({
        id: g.id,
        name: g.name || '(unnamed group)',
        participants: g.count,
        owner: isMe(g.owner),
        community: false,
      });
    }
    groups.sort((a, b) => a.name.localeCompare(b.name));
    console.log(`[wa] ${type}: ${groups.length} allowed of ${raw.length} (GROUP_FILTER=${cfg.GROUP_FILTER}) ` +
                `in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    groupCache[type] = { at: Date.now(), list: groups };
    return groups;
  } finally {
    readingGroups = false;
  }
}

async function sendToGroup(groupId, text, media) {
  if (state.status !== 'ready') throw new Error('WhatsApp is not connected');
  // Safety check: never send to a group outside the allowed set.
  if (!(await findAllowed(groupId))) {
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
  try { await withTimeout(client.logout(), 20_000); } catch (_) {}
  await restart('unlinked from the dashboard', { clearSession: true, delayMs: 2000 });
}

module.exports = { state, start, getGroups, findAllowed, sendToGroup, logout, _healthCheck: healthCheck };
