const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { DB_FILE, DB_DIR } = require('../src/db');

console.log('=== Starting queuectl run_at test ===');

// 1. Clear database for clean run
if (fs.existsSync(DB_FILE)) {
  fs.unlinkSync(DB_FILE);
  console.log('Cleared existing database file.');
}
const pidsFile = path.join(DB_DIR, 'workers.pids');
if (fs.existsSync(pidsFile)) {
  fs.unlinkSync(pidsFile);
}

function runCLI(cmdArgs) {
  try {
    if (cmdArgs.startsWith('worker start')) {
      const { spawn } = require('child_process');
      const args = cmdArgs.split(' ');
      const child = spawn('node', [path.join(__dirname, '../bin/queuectl.js'), ...args], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      // Sleep briefly to allow processes to start and write pids
      const waitTill = Date.now() + 500;
      while (Date.now() < waitTill) {}
      return 'Starting workers asynchronously...';
    }
    return execSync(`node bin/queuectl.js ${cmdArgs}`, { encoding: 'utf8' });
  } catch (err) {
    return err.stdout + '\n' + err.stderr;
  }
}

// 2. Enqueue a job to run 3 seconds in the future
console.log('Enqueuing job with delay of 3 seconds...');
const enqueueOutput = runCLI('enqueue "echo \'Scheduled Job Ran\'" --run-at 3');
console.log(enqueueOutput);

let parsedJob;
try {
  // Find lines starting with { and ending with } in the output, or try to parse JSON
  const jsonStr = enqueueOutput.substring(enqueueOutput.indexOf('{'), enqueueOutput.lastIndexOf('}') + 1);
  parsedJob = JSON.parse(jsonStr);
} catch (e) {
  console.error('FAIL: Could not parse enqueued job details as JSON:', e.message);
  process.exit(1);
}

console.log('Enqueued Job ID:', parsedJob.id);
console.log('Enqueued Job run_at:', parsedJob.run_at);

const runAtDate = new Date(parsedJob.run_at);
const now = new Date();
const diffMs = runAtDate - now;

console.log(`run_at is scheduled in the future by ~${(diffMs / 1000).toFixed(2)} seconds.`);
if (diffMs < 2000 || diffMs > 4000) {
  console.error('FAIL: scheduled run_at date is not in the correct range of ~3 seconds in the future');
  process.exit(1);
}

// 3. Start a worker
console.log('Starting worker process...');
runCLI('worker start --count 1');

// 4. Verify after 1 second that the job is still pending
console.log('Waiting 1 second to verify job is NOT processed immediately...');
setTimeout(() => {
  const statusOutput = runCLI('status');
  console.log(statusOutput);
  
  if (!statusOutput.includes('Pending:    1')) {
    console.error('FAIL: Job should be pending after 1 second because it is scheduled in the future.');
    runCLI('worker stop');
    process.exit(1);
  }
  
  console.log('SUCCESS: Job remained pending after 1 second.');

  // 5. Wait 3 more seconds (total 4 seconds since enqueue) to let the worker process it
  console.log('Waiting 3 more seconds to let the scheduled time pass...');
  setTimeout(() => {
    const finalStatus = runCLI('status');
    console.log(finalStatus);

    // Stop workers
    runCLI('worker stop');

    if (finalStatus.includes('Completed:  1')) {
      console.log('SUCCESS: Scheduled job completed successfully after the run_at time arrived!');
      process.exit(0);
    } else {
      console.error('FAIL: Job was not completed after its run_at time arrived.');
      process.exit(1);
    }
  }, 3000);
}, 1000);
