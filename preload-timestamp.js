const formatArg = (a) => {
  if (a instanceof Error) return a.stack;
  if (typeof a === 'object' && a !== null) return JSON.stringify(a);
  return String(a);
};

const getStderrLevel = (msg) => /^\(node:\d+\) \w*Warning:/.test(msg) ? 'WARN' : 'ERROR';

const writeLogMsg = (level, msg) =>
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), level, message: msg }) + '\n');

const writeLog = (level, args) => writeLogMsg(level, args.map(formatArg).join(' '));

console.log   = (...args) => writeLog('LOG',   args);
console.error = (...args) => {
  const msg = args.map(formatArg).join(' ');
  writeLogMsg(getStderrLevel(msg), msg);
};
console.warn  = (...args) => writeLog('WARN',  args);
console.info  = (...args) => writeLog('INFO',  args);
console.debug = (...args) => writeLog('DEBUG', args);
console.trace = (...args) => writeLog('TRACE', args);

process.stderr.write = function(chunk, encoding, callback) {
  const msg = chunk.toString().trimEnd();
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level: getStderrLevel(msg), message: msg });
  return process.stdout.write(line + '\n', encoding, callback);
};

// Auto-deploy: copy updated server.js and restart
setImmediate(() => {
  try {
    const fs = require('fs');
    const path = require('path');
    const src = '/home/u706448493/domains/brservice.com/public_html/server.js';
    const dst = '/home/u706448493/domains/brservice.com/nodejs/server.js';
    const restartFile = '/home/u706448493/domains/brservice.com/nodejs/tmp/restart.txt';
    if (fs.existsSync(src)) {
      const srcContent = fs.readFileSync(src, 'utf8');
      let needsUpdate = true;
      if (fs.existsSync(dst)) {
        const dstContent = fs.readFileSync(dst, 'utf8');
        needsUpdate = srcContent !== dstContent;
      }
      if (needsUpdate) {
        fs.mkdirSync(path.dirname(restartFile), { recursive: true });
        fs.copyFileSync(src, dst);
        fs.writeFileSync(restartFile, new Date().toISOString());
        console.log('[deploy] server.js atualizado, restart acionado');
      }
    }
  } catch(e) {
    console.log('[deploy] erro:', e.message);
  }
});
