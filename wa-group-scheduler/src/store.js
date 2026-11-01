// Tiny JSON-file store for scheduled messages. Fine for personal use (hundreds/thousands of jobs).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { STORE_FILE } = require('./config');

let jobs = [];

function load() {
  try {
    jobs = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!Array.isArray(jobs)) jobs = [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[store] could not read store, starting empty:', e.message);
    jobs = [];
  }
  // Anything stuck mid-send from a crash goes back to pending.
  for (const j of jobs) if (j.status === 'sending') j.status = 'pending';
  save();
}

function save() {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function all() {
  return [...jobs].sort((a, b) => new Date(a.sendAt) - new Date(b.sendAt));
}

function get(id) {
  return jobs.find(j => j.id === id);
}

function add(job) {
  const full = {
    id: crypto.randomUUID(),
    status: 'pending', // pending | sending | sent | failed | missed
    createdAt: new Date().toISOString(),
    sentAt: null,
    error: null,
    ...job,
  };
  jobs.push(full);
  save();
  return full;
}

function update(id, patch) {
  const j = get(id);
  if (!j) return null;
  Object.assign(j, patch);
  save();
  return j;
}

function remove(id) {
  const j = get(id);
  if (!j) return null;
  jobs = jobs.filter(x => x.id !== id);
  save();
  return j;
}

// Is this uploaded file still used by any other job?
function mediaInUse(mediaPath) {
  return jobs.some(j => j.media && j.media.path === mediaPath);
}

module.exports = { load, all, get, add, update, remove, mediaInUse };
