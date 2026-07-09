const { transaction } = require('./db');
const { getConfig } = require('./config');

function generateId() {
  return 'job_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
}

/**
 * Enqueue a new job.
 * If externalId is provided (e.g. from JSON input command), use it.
 */
function enqueueJob(command, externalId = null, runAt = null) {
  const cfg = getConfig();
  const now = new Date().toISOString();

  const newJob = {
    id: externalId || generateId(),
    command: command,
    state: 'pending',
    attempts: 0,
    max_retries: cfg.max_retries,
    created_at: now,
    updated_at: now,
    run_at: runAt || now
  };

  transaction((db) => {
    // If a job with this ID already exists in non-final state, we can overwrite or fail.
    // Let's replace or append.
    const existingIndex = db.jobs.findIndex(j => j.id === newJob.id);
    if (existingIndex > -1) {
      db.jobs[existingIndex] = newJob;
    } else {
      db.jobs.push(newJob);
    }
  });

  return newJob;
}

/**
 * Lists jobs filtered by state.
 */
function listJobs(state = null) {
  return transaction((db) => {
    if (!state) return db.jobs;
    return db.jobs.filter(j => j.state === state);
  });
}

/**
 * Gets stats summarizing job states and active workers.
 */
function getStats() {
  return transaction((db) => {
    const counts = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      dead: 0
    };

    db.jobs.forEach(j => {
      if (counts[j.state] !== undefined) {
        counts[j.state]++;
      }
    });

    const activeWorkers = [];
    const now = Date.now();

    if (db.activeWorkers) {
      for (const [pid, details] of Object.entries(db.activeWorkers)) {
        // If worker updated heartbeat in the last 10 seconds, count as active
        if (now - details.last_seen < 10000) {
          activeWorkers.push({ pid: parseInt(pid), ...details });
        }
      }
    }

    return {
      jobs: counts,
      workersCount: activeWorkers.length,
      workers: activeWorkers
    };
  });
}

/**
 * Retry a job specifically in the DLQ (dead state).
 */
function retryDlqJob(id) {
  return transaction((db) => {
    const job = db.jobs.find(j => j.id === id);
    if (!job) {
      throw new Error(`Job ${id} not found`);
    }
    if (job.state !== 'dead') {
      throw new Error(`Job ${id} is not in the Dead Letter Queue (state: ${job.state})`);
    }

    const now = new Date().toISOString();
    job.state = 'pending';
    job.attempts = 0;
    job.run_at = now;
    job.updated_at = now;
    return job;
  });
}

/**
 * Worker Heartbeat: registers worker process as active
 */
function workerHeartbeat(pid, statusMsg = 'idle') {
  transaction((db) => {
    if (!db.activeWorkers) db.activeWorkers = {};
    db.activeWorkers[pid] = {
      last_seen: Date.now(),
      status: statusMsg
    };
  });
}

/**
 * Worker Deregister: removes worker from active list
 */
function workerDeregister(pid) {
  transaction((db) => {
    if (db.activeWorkers && db.activeWorkers[pid]) {
      delete db.activeWorkers[pid];
    }
  });
}

module.exports = {
  enqueueJob,
  listJobs,
  getStats,
  retryDlqJob,
  workerHeartbeat,
  workerDeregister
};
