// Checks every 15 seconds for messages that are due and sends them one at a time.
const store = require('./store');
const wa = require('./whatsapp');
const cfg = require('./config');

let busy = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomGap = () =>
  1000 * (cfg.MIN_GAP_SECONDS + Math.random() * Math.max(0, cfg.MAX_GAP_SECONDS - cfg.MIN_GAP_SECONDS));

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    const due = store.all().filter(j => j.status === 'pending' && new Date(j.sendAt).getTime() <= now);
    if (!due.length) return;

    // Too late? Mark as missed rather than surprising the group hours later.
    const maxLateMs = cfg.MAX_LATE_MINUTES * 60_000;
    const sendable = [];
    for (const j of due) {
      if (now - new Date(j.sendAt).getTime() > maxLateMs) {
        store.update(j.id, { status: 'missed', error: `Not sent within ${cfg.MAX_LATE_MINUTES} min of the scheduled time` });
      } else {
        sendable.push(j);
      }
    }
    if (!sendable.length || wa.state.status !== 'ready') return; // will retry next tick

    for (let i = 0; i < sendable.length; i++) {
      const j = sendable[i];
      if (wa.state.status !== 'ready') break;
      store.update(j.id, { status: 'sending' });
      try {
        await wa.sendToGroup(j.groupId, j.message, j.media);
        store.update(j.id, { status: 'sent', sentAt: new Date().toISOString(), error: null });
        console.log(`[scheduler] sent to "${j.groupName}"`);
      } catch (e) {
        store.update(j.id, { status: 'failed', error: e.message });
        console.error(`[scheduler] failed for "${j.groupName}":`, e.message);
      }
      if (i < sendable.length - 1) await sleep(randomGap());
    }
  } finally {
    busy = false;
  }
}

function start() {
  setInterval(() => tick().catch(e => console.error('[scheduler]', e)), 15_000);
}

module.exports = { start, tick };
