const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');
const os = require('os');

const FTP_HOST = 'brservice.com';
const FTP_USER = 'u706448493.Josimar';
const FTP_PASS = 'Josimar8821';
const REMOTE_DIR = '/home/u706448493/domains/brservice.com/public_html';

const LOCAL_DIR = __dirname;

const EXCLUDE = new Set([
  'node_modules',
  '.git',
  'deploy.js',
  '.gitignore',
  'database.sqlite',
  'package-lock.json',
]);

async function deploy() {
  const client = new ftp.Client();
  client.ftp.verbose = true;

  try {
    console.log('Conectando ao FTP...');
    await client.access({
      host: FTP_HOST,
      user: FTP_USER,
      password: FTP_PASS,
      secure: false,
    });

    console.log('Listando diretório remoto...');
    console.log(await client.list());

    console.log('Enviando arquivos...');

    await client.ensureDir(REMOTE_DIR);
    await client.clearWorkingDir();
    await client.cd(REMOTE_DIR);

    const files = fs.readdirSync(LOCAL_DIR).filter(f => {
      if (EXCLUDE.has(f)) return false;
      const full = path.join(LOCAL_DIR, f);
      if (fs.statSync(full).isDirectory()) return false;
      return true;
    });

    for (const file of files) {
      const localPath = path.join(LOCAL_DIR, file);
      console.log(`  -> ${file}`);
      await client.uploadFrom(localPath, file);
    }

    console.log('Upload concluído!');

    await client.ensureDir('tmp');
    await client.cd(REMOTE_DIR);
    const tmpFile = path.join(os.tmpdir(), 'restart.txt');
    fs.writeFileSync(tmpFile, 'restart');
    await client.uploadFrom(tmpFile, 'tmp/restart.txt');
    fs.unlinkSync(tmpFile);
    console.log('Aplicação reiniciada via restart.txt!');

  } catch (err) {
    console.error('Erro no deploy:', err);
  } finally {
    client.close();
  }
}

deploy();
