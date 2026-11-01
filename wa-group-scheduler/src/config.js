const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

module.exports = {
  PORT: Number(process.env.PORT || 3000),
  DATA_DIR,
  SESSION_DIR: path.join(DATA_DIR, 'session'),
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
  STORE_FILE: path.join(DATA_DIR, 'schedules.json'),

  // Dashboard login (HTTP Basic Auth). A password is required.
  DASHBOARD_USER: process.env.DASHBOARD_USER || 'admin',
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || '',

  // Which groups can be scheduled to:
  //   owner -> only groups you created (default)
  //   admin -> groups you created + groups where you are admin
  //   all   -> every group you are in (use only if owner detection fails)
  GROUP_FILTER: (process.env.GROUP_FILTER || 'owner').toLowerCase(),

  // If the server was down / WhatsApp disconnected at the scheduled time,
  // still send messages that are at most this many minutes late. Older ones are marked "missed".
  MAX_LATE_MINUTES: Number(process.env.MAX_LATE_MINUTES || 60),

  // Random pause between consecutive sends (seconds) to look less bot-like.
  MIN_GAP_SECONDS: Number(process.env.MIN_GAP_SECONDS || 4),
  MAX_GAP_SECONDS: Number(process.env.MAX_GAP_SECONDS || 10),

  MAX_UPLOAD_MB: Number(process.env.MAX_UPLOAD_MB || 64),

  // Path to Chrome/Chromium. Leave empty to use the one Puppeteer downloads.
  CHROME_PATH: process.env.CHROME_PATH || undefined,
};
