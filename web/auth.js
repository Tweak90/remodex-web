// Persistent single-user scrypt credentials added by the remodex-web fork.
import { open, mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const parameters = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 64 });
const memoryLimit = 32 * 1024 * 1024;
const storeError = () => Object.assign(new Error('Passwortspeicher konnte nicht sicher gelesen oder gespeichert werden.'), { status: 503 });

function decode(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw storeError();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) throw storeError();
  return bytes;
}

function validateRecord(record) {
  if (!record || record.version !== 1 || record.algorithm !== 'scrypt') throw storeError();
  const options = record.parameters;
  if (!options || Object.keys(options).length !== Object.keys(parameters).length
    || Object.entries(parameters).some(([key, value]) => options[key] !== value)) throw storeError();
  decode(record.salt, 32);
  decode(record.hash, parameters.keyLength);
  return record;
}

async function createRecord(password) {
  const salt = randomBytes(32);
  const hash = await derive(password, salt, parameters.keyLength, { ...parameters, maxmem: memoryLimit });
  return {
    version: 1, algorithm: 'scrypt', parameters,
    salt: salt.toString('base64url'), hash: hash.toString('base64url'),
  };
}

async function loadRecord(filename) {
  let file;
  try {
    file = await open(filename, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw storeError();
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > 4096) throw storeError();
    const content = await file.readFile({ encoding: 'utf8' });
    if (Buffer.byteLength(content) > 4096) throw storeError();
    const record = validateRecord(JSON.parse(content));
    await file.chmod(0o600);
    return record;
  } catch {
    throw storeError();
  } finally {
    await file.close();
  }
}

async function saveRecord(filename, record) {
  if (!filename) return;
  const directory = dirname(filename);
  const temporary = join(directory, `.${basename(filename)}.${randomBytes(16).toString('hex')}.tmp`);
  let file;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(record));
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, filename);
  } catch {
    await file?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw storeError();
  }
}

export async function createPasswordStore({ password, authStateFile } = {}) {
  let record = authStateFile ? await loadRecord(authStateFile) : null;
  if (!record) {
    if (typeof password !== 'string' || password.length < 4 || password.length > 1024)
      throw new Error('Das initiale Passwort muss zwischen 4 und 1024 Zeichen enthalten.');
    try { record = await createRecord(password); }
    catch { throw storeError(); }
    await saveRecord(authStateFile, record);
  }

  const access = {
    async verify(candidate) {
      if (typeof candidate !== 'string' || candidate.length < 4 || candidate.length > 1024) return false;
      let actual;
      try {
        actual = await derive(candidate, decode(record.salt, 32), parameters.keyLength, { ...parameters, maxmem: memoryLimit });
        return timingSafeEqual(actual, decode(record.hash, parameters.keyLength));
      } catch { throw storeError(); }
      finally { actual?.fill(0); }
    },
    async replace(nextPassword) {
      let next;
      try { next = await createRecord(nextPassword); }
      catch { throw storeError(); }
      await saveRecord(authStateFile, next);
      record = next;
    },
  };
  let queue = Promise.resolve();
  return {
    transaction(action) {
      const result = queue.then(() => action(access));
      queue = result.catch(() => {});
      return result;
    },
  };
}
