// Auto-fix for whatsapp-web.js 1.34.x media sends on current WhatsApp Web
// ("Data passed to getter must include an id property ... got undefined").
// When image/video data is merged into the outgoing message, its internal id
// (__x_id / id) overwrites the message id. This puts the real id back.
// Upstream: github.com/wwebjs/whatsapp-web.js issue #201922, PR #201923.
// Runs at startup before whatsapp-web.js loads; does nothing if already applied
// or if the library has changed so the patch no longer fits.
const fs = require('fs');
const path = require('path');

const MARKER = '/* wa-group-scheduler media id fix */';

function apply() {
  let file;
  try {
    file = path.join(path.dirname(require.resolve('whatsapp-web.js/package.json')), 'src/util/Injected/Utils.js');
  } catch (_) { return; }

  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  if (src.includes(MARKER)) return;

  // The outgoing message object in window.WWebJS.sendMessage ends with "...extraOptions, };".
  // It starts with "id: newMsgKey" — only patch that one.
  const re = /(id: newMsgKey,[\s\S]*?\.\.\.extraOptions,\s*\n\s*\};)/;
  if (!re.test(src)) {
    console.warn('[patch] whatsapp-web.js layout changed; media id fix not applied (may no longer be needed)');
    return;
  }
  src = src.replace(re, `$1\n        ${MARKER}\n        delete message.__x_id;\n        message.id = newMsgKey;`);
  try {
    fs.writeFileSync(file, src);
    console.log('[patch] applied media id fix to whatsapp-web.js');
  } catch (e) {
    console.warn('[patch] could not write fix:', e.message);
  }
}

apply();
