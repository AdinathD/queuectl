const fs = require('fs');
const path = require('path');

// Target directory and file paths
const DB_DIR = path.join(process.env.APPDATA || path.join(process.env.HOME || '.', '.config'), 'queuectl');
const DB_FILE = path.join(DB_DIR, 'db.json');
const LOCK_FILE = path.join(DB_DIR, 'db.lock');

// Make sure target dir exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM' || err.code === 'EINVAL';
  }
}

/**
 * Acquire lock using fs.openSync with 'wx' flag (exclusive create).
 * If the lock file exists, we will retry after a short delay.
 */
function acquireLock(timeoutMs = 10000, retryIntervalMs = 50) {
  const start = Date.now();
  while (true) {
    try {
      // 'wx' flag fails if lock file already exists
      const fd = fs.openSync(LOCK_FILE, 'wx');
      // Store current process ID for debug/tracking if needed
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Lock file exists, check if it's stale (e.g. process that created it died)
        try {
          const ownerPidStr = fs.readFileSync(LOCK_FILE, 'utf8').trim();
          if (ownerPidStr === "") {
            // Empty lock file is stale. Delete it immediately.
            fs.unlinkSync(LOCK_FILE);
          } else {
            const ownerPid = parseInt(ownerPidStr, 10);
            if (!isNaN(ownerPid)) {
              if (!isProcessAlive(ownerPid)) {
                // Process is dead! The lock is stale. Delete it immediately.
                fs.unlinkSync(LOCK_FILE);
              }
            } else {
              // Invalid PID format is stale. Delete it.
              fs.unlinkSync(LOCK_FILE);
            }
          }
        } catch (_) {}

        if (Date.now() - start > timeoutMs) {
          throw new Error('Lock acquisition timed out');
        }
        // Sleep using synchronous block/wait
        const waitTill = Date.now() + retryIntervalMs;
        while (Date.now() < waitTill) {}
      } else {
        throw err;
      }
    }
  }
}

/**
 * Release lock by unlinking the lock file.
 */
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (err) {
    // Ignore error if already deleted
  }
}

/**
 * Read the DB file safely. Returns parsed data.
 */
function readDbRaw() {
  if (!fs.existsSync(DB_FILE)) {
    return { jobs: [], config: {}, activeWorkers: {} };
  }
  try {
    const content = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    // Return default if corrupt or empty
    return { jobs: [], config: {}, activeWorkers: {} };
  }
}

/**
 * Write to DB file atomically by writing to temporary file and renaming it.
 */
function writeDbRaw(data) {
  const tempPath = `${DB_FILE}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, DB_FILE);
}

/**
 * Run a database operation inside a lock transaction.
 */
function transaction(fn) {
  acquireLock();
  try {
    const db = readDbRaw();
    const result = fn(db);
    writeDbRaw(db);
    return result;
  } finally {
    releaseLock();
  }
}

module.exports = {
  transaction,
  DB_DIR,
  DB_FILE
};
