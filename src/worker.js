const { exec } = require('child_process');
const { transaction } = require('./db');
const { workerHeartbeat, workerDeregister } = require('./queue');
const { getConfig } = require('./config');

let shouldExit = false;
let currentChildProcess = null;

// Graceful shutdown registration
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

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
  workerDeregister(process.pid);
  process.exit(0);
}

/**
 * Polls the queue, acquires the next available job, executes it, and manages states/retries.
 */
function runWorker() {
  console.log(`[Worker ${process.pid}] Started job processing loop.`);

  function poll() {
    if (shouldExit) {
      cleanupAndExit();
      return;
    }

    workerHeartbeat(process.pid, 'polling');

    // Attempt to acquire next available job atomically
    const job = transaction((db) => {
      const now = new Date();

      // Find a job that is pending or failed and ready to run
      const eligibleJob = db.jobs.find(j => {
        if (j.state !== 'pending' && j.state !== 'failed') return false;
        if (j.run_at && new Date(j.run_at) > now) return false;
        return true;
      });

      if (eligibleJob) {
        eligibleJob.state = 'processing';
        eligibleJob.updated_at = now.toISOString();
        return { ...eligibleJob }; // return a snapshot copy
      }
      return null;
    });

    if (!job) {
      // Nothing to process, poll again in 1 second
      setTimeout(poll, 1000);
      return;
    }

    // Process the job
    console.log(`[Worker ${process.pid}] Executing job ${job.id}: "${job.command}"`);
    workerHeartbeat(process.pid, `executing ${job.id}`);

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
      const now = new Date().toISOString();

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
