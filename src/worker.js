const { exec } = require('child_process');
const { transaction } = require('./db');
const { workerHeartbeat, workerDeregister } = require('./queue');
const { getConfig } = require('./config');

let shouldExit = false;
let currentChildProcess = null;
let heartbeatInterval = null;
let currentJob = null;

// Graceful shutdown registration
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
process.on('SIGBREAK', handleShutdown);

function handleShutdown() {
  console.log(`[Worker ${process.pid}] Shutting down gracefully...`);
  shouldExit = true;
  if (currentChildProcess) {
    console.log(`[Worker ${process.pid}] Waiting for running command to finish execution...`);
  } else {
    cleanupAndExit();
  }
}

function cleanupAndExit() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  workerDeregister(process.pid);
  process.exit(0);
}

/**
 * Polls the queue, acquires the next available job, executes it, and manages states/retries.
 */
function runWorker() {
  console.log(`[Worker ${process.pid}] Started job processing loop.`);

  // Send heartbeats continuously in background (even during long jobs)
  heartbeatInterval = setInterval(() => {
    const status = currentJob ? `executing ${currentJob.id}` : 'polling';
    workerHeartbeat(process.pid, status);
  }, 1000);

  // Send an immediate first heartbeat so status immediately reflects active state
  workerHeartbeat(process.pid, 'polling');

  function poll() {
    if (shouldExit) {
      cleanupAndExit();
      return;
    }

    // Attempt to acquire next available job atomically
    const job = transaction((db) => {
      const now = new Date();
      const cfg = db.config || {};

      // 1. Check if this worker was requested to shut down remotely
      if (db.activeWorkers && db.activeWorkers[process.pid] && db.activeWorkers[process.pid].shutdown_requested) {
        shouldExit = true;
        return null;
      }

      // 2. Recover orphaned/crashed processing jobs
      if (db.activeWorkers) {
        const currentTime = Date.now();

        // Automatically prune any idle or busy crashed workers from the database
        for (const [wpid, details] of Object.entries(db.activeWorkers)) {
          if (currentTime - details.last_seen > 30000) {
            delete db.activeWorkers[wpid];
          }
        }
      }

      if (db.jobs && db.activeWorkers) {
        const currentTime = Date.now();
        db.jobs.forEach(j => {
          if (j.state === 'processing') {
            const worker = db.activeWorkers[j.worker_pid];
            const isWorkerAlive = worker && (currentTime - worker.last_seen < 10000);

            if (!isWorkerAlive) {
              // Reclaim/Fail the job
              const newAttempts = j.attempts + 1;
              const maxRetries = j.max_retries !== undefined ? j.max_retries : (cfg.max_retries || 2);
              j.updated_at = now.toISOString();
              j.attempts = newAttempts;
              
              // Clean up the crashed worker record from the database
              if (db.activeWorkers && db.activeWorkers[j.worker_pid]) {
                delete db.activeWorkers[j.worker_pid];
              }
              delete j.worker_pid; // Clear owner PID

              if (newAttempts >= maxRetries) {
                j.state = 'dead';
                console.warn(`[Recovery] Job ${j.id} was orphaned (worker crashed) and exceeded max retries. Moved to DLQ.`);
              } else {
                j.state = 'failed';
                const backoffBase = cfg.backoff_base || 2;
                const delay = Math.pow(backoffBase, newAttempts - 1);
                j.run_at = new Date(Date.now() + delay * 1000).toISOString();
                console.warn(`[Recovery] Job ${j.id} was orphaned (worker crashed). Resetting to failed state for retry in ${delay}s (Attempt ${newAttempts}/${maxRetries}).`);
              }
            }
          }
        });
      }

      // 3. Find a job that is pending or failed and ready to run
      const eligibleJob = db.jobs.find(j => {
        if (j.state !== 'pending' && j.state !== 'failed') return false;
        if (j.run_at && new Date(j.run_at) > now) return false;
        return true;
      });

      if (eligibleJob) {
        eligibleJob.state = 'processing';
        eligibleJob.worker_pid = process.pid;
        eligibleJob.updated_at = now.toISOString();
        return { ...eligibleJob }; // return a snapshot copy
      }
      return null;
    });

    if (!job) {
      if (shouldExit) {
        cleanupAndExit();
        return;
      }
      // Nothing to process, poll again in 1 second
      setTimeout(poll, 1000);
      return;
    }

    currentJob = job;

    // Process the job
    console.log(`[Worker ${process.pid}] Executing job ${job.id}: "${job.command}"`);

    const cfg = getConfig();
    const timeoutSeconds = cfg.timeout || 30;

    let hasTimedOut = false;
    const timeoutTimer = setTimeout(() => {
      if (currentChildProcess) {
        hasTimedOut = true;
        console.warn(`[Worker ${process.pid}] Job ${job.id} exceeded execution timeout of ${timeoutSeconds}s. Terminating process...`);
        if (process.platform === 'win32') {
          exec(`taskkill /pid ${currentChildProcess.pid} /T /F`, () => { });
        } else {
          currentChildProcess.kill();
        }
      }
    }, timeoutSeconds * 1000);

    currentChildProcess = exec(job.command, (error, stdout, stderr) => {
      clearTimeout(timeoutTimer);
      currentChildProcess = null;
      currentJob = null;
      const now = new Date().toISOString();

      if (stdout && stdout.trim()) {
        console.log(stdout.trim());
      }
      if (stderr && stderr.trim()) {
        console.error(stderr.trim());
      }

      if (error) {
        // Job execution failed
        const newAttempts = job.attempts + 1;
        const maxRetries = job.max_retries !== undefined ? job.max_retries : cfg.max_retries;
        const backoffBase = cfg.backoff_base || 2;

        if (hasTimedOut) {
          console.error(`[Worker ${process.pid}] Job ${job.id} failed due to execution timeout.`);
        } else {
          console.error(`[Worker ${process.pid}] Job ${job.id} failed with exit code ${error.code || 1}. Error: ${error.message.trim()}`);
        }

        transaction((db) => {
          const dbJob = db.jobs.find(j => j.id === job.id);
          if (dbJob) {
            dbJob.attempts = newAttempts;
            dbJob.updated_at = now;
            delete dbJob.worker_pid; // Clear owner PID on failure

            if (newAttempts >= maxRetries) {
              dbJob.state = 'dead';
              console.log(`[Worker ${process.pid}] Job ${job.id} exhausted all retries. Moved to Dead Letter Queue (DLQ).`);
            } else {
              dbJob.state = 'failed';
              // Exponential Backoff: delay = base^attempts seconds
              const delaySeconds = Math.pow(backoffBase, newAttempts);
              const runAtTime = new Date(Date.now() + delaySeconds * 1000).toISOString();
              dbJob.run_at = runAtTime;
              console.log(`[Worker ${process.pid}] Job ${job.id} scheduled for retry in ${delaySeconds}s (at ${runAtTime}).`);
            }
          }
        });
      } else {
        // Job execution succeeded
        console.log(`[Worker ${process.pid}] Job ${job.id} completed successfully.`);
        transaction((db) => {
          const dbJob = db.jobs.find(j => j.id === job.id);
          if (dbJob) {
            dbJob.state = 'completed';
            dbJob.updated_at = now;
            delete dbJob.worker_pid; // Clear owner PID on success
          }
        });
      }

      // Immediately look for next job
      setTimeout(poll, 100);
    });
  }

  // Start polling loop
  poll();
}

if (require.main === module) {
  runWorker();
}

module.exports = {
  runWorker
};
