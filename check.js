const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    await client.access({ host: 'cardapio.sbs', user: 'u706448493.Josimar', password: 'Josimar8821', secure: false });
    await client.cd('/home/u706448493/domains/cardapio.sbs/public_html');

    // Check root dir too
    const files = await client.list();
    console.log('Files in public_html:', files.map(f => f.name).join(', '));

    const tmpFile = path.join(os.tmpdir(), 'check-index.html');
    await client.downloadTo(tmpFile, 'index.html');
    const content = fs.readFileSync(tmpFile, 'utf-8');

    const match = content.match(/<title>(.*?)<\/title>/);
    console.log('Title:', match ? match[1] : 'not found');

    if (content.includes('BR Service')) {
      console.log('OK: Server has "BR Service"');
    }

    fs.unlinkSync(tmpFile);
  } catch(e) { console.error(e); }
  finally { client.close(); }
})();
