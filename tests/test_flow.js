const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { DB_FILE, DB_DIR, transaction } = require('../src/db');

console.log('=== Starting QueueCTL Flow Verification ===');

// 1. Clear existing database for clean test run
if (fs.existsSync(DB_FILE)) {
  fs.unlinkSync(DB_FILE);
  console.log('Cleared existing database file.');
}
const pidsFile = path.join(DB_DIR, 'workers.pids');
if (fs.existsSync(pidsFile)) {
  fs.unlinkSync(pidsFile);
}

// Helper to run queuectl cli synchronously and return stdout
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
      while (Date.now() < waitTill) { }
      return 'Starting workers asynchronously...';
    }
    return execSync(`node bin/queuectl.js ${cmdArgs}`, { encoding: 'utf8' });
  } catch (err) {
    return err.stdout + '\n' + err.stderr;
  }
}

// 2. Set Config
console.log('\n--- Test 1: Configuration Management ---');
const configOutput = runCLI('config set max-retries 2');
console.log(configOutput);
if (!configOutput.includes('"max_retries": 2')) {
  console.error('FAIL: max-retries config failed to update');
  process.exit(1);
}
runCLI('config set backoff-base 2');

// 3. Enqueue jobs
console.log('\n--- Test 2: Enqueuing Jobs ---');
const job1 = runCLI(`enqueue "echo 'Success Job'"`);
console.log('Job 1 response:', job1);

const job2 = runCLI(`enqueue "invalidcommandhere123"`);
console.log('Job 2 response (failing command):', job2);

// Enqueue via JSON representation
const job3 = runCLI(`enqueue "{\\"id\\":\\"jsonjob\\",\\"command\\":\\"echo 'JSON command'\\"}"`);
console.log('Job 3 response (JSON input):', job3);

// 4. Check Status Before Workers Start
console.log('\n--- Test 3: Checking initial status ---');
const initialStatus = runCLI('status');
console.log(initialStatus);

// 5. Start Workers
console.log('\n--- Test 4: Starting 2 Workers ---');
const startWorkers = runCLI('worker start --count 2');
console.log(startWorkers);

// Give workers time to pick up jobs, execute, fail/retry
console.log('Waiting for workers to process jobs (4 seconds for testing)...');
let elapsed = 0;
const interval = setInterval(() => {
  elapsed += 2;
  console.log(`Checking status after ${elapsed}s:`);
  console.log(runCLI('status'));
  if (elapsed >= 4) {
    clearInterval(interval);
    finishTest();
  }
}, 2000);

function finishTest() {
  // 6. Stop workers
  console.log('\n--- Test 5: Gracefully Stopping Workers ---');
  const stopWorkers = runCLI('worker stop');
  console.log(stopWorkers);

  // 7. Check DLQ and list command
  console.log('\n--- Test 6: Listing all dead jobs ---');
  const dlqList = runCLI('dlq list');
  console.log(dlqList);

  if (dlqList.includes('invalidcommandhere123')) {
    console.log('SUCCESS: Failed job correctly landed in the Dead Letter Queue (DLQ).');
  } else {
    console.error('FAIL: Failed job did not land in DLQ.');
    process.exit(1);
  }

  // 8. Retry DLQ Job
  console.log('\n--- Test 7: Retrying a DLQ Job ---');
  // Find the ID of the dead job
  const deadJobs = JSON.parse(runCLI('dlq list'));
  if (deadJobs.length > 0) {
    const deadJobId = deadJobs[0].id;
    const retryResult = runCLI(`dlq retry ${deadJobId}`);
    console.log(retryResult);
  } else {
    console.error('FAIL: No dead jobs found to retry');
  }
  // Let's check status again
  const finalStatus = runCLI('status');
  console.log(finalStatus);

  // 9. Job Timeout Test
  console.log('\n--- Test 8: Job Timeout Verification ---');
  console.log('Setting timeout config to 2s...');
  runCLI('config set timeout 2');

  console.log('Enqueuing a 10-second job...');
  const enqueueOutput = runCLI('enqueue "ping 127.0.0.1 -n 10"');
  console.log(enqueueOutput);

  console.log('Starting 1 worker...');
  runCLI('worker start --count 1');

  console.log('Waiting 3.5 seconds for job to hit timeout...');
  setTimeout(() => {
    const statusOutput = runCLI('status');
    console.log(statusOutput);

    console.log('Stopping worker...');
    const stopOutput = runCLI('worker stop');
    console.log(stopOutput);

    console.log('Resetting timeout config back to 30s...');
    const resetOutput = runCLI('config set timeout 30');
    console.log(resetOutput);

    if (statusOutput.includes('Failed:     1') || statusOutput.includes('Dead (DLQ): 1')) {
      console.log('SUCCESS: Job execution was aborted and marked as failed due to the 2-second timeout.');

      // 10. Restart Survival Verification Test
      console.log('\n--- Test 9: Restart Survival Verification ---');
      console.log('Stopping all running workers to ensure offline state...');
      runCLI('worker stop');

      console.log('Enqueuing a job while workers are offline...');
      const survivalEnqueue = runCLI('enqueue "echo \'Data Persistence Job\'"');
      console.log(survivalEnqueue);

      // Clear all other jobs from DB to prevent worker from picking them up
      transaction((db) => {
        db.jobs = db.jobs.filter(j => j.command === "echo 'Data Persistence Job'");
      });

      console.log('Checking if job data was physically written to db.json on disk...');
      if (fs.existsSync(DB_FILE)) {
        const dbContent = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const foundJob = dbContent.jobs.find(j => j.command === "echo 'Data Persistence Job'");
        if (foundJob) {
          console.log(`SUCCESS: Job '${foundJob.id}' was physically saved to db.json on disk.`);
        } else {
          console.error('FAIL: Job was not found in db.json on disk.');
          process.exit(1);
        }
      } else {
        console.error('FAIL: db.json file does not exist on disk.');
        process.exit(1);
      }

      console.log('Starting a fresh worker (Simulating system/worker restart)...');
      runCLI('worker start --count 1');

      console.log('Waiting 2 seconds for restarted worker to process the job...');
      setTimeout(() => {
        const afterRestartStatus = runCLI('status');
        console.log(afterRestartStatus);

        console.log('Stopping worker...');
        runCLI('worker stop');

        const listCompleted = runCLI('list --state completed');
        if (listCompleted.includes("echo 'Data Persistence Job'")) {
          console.log('SUCCESS: Offline enqueued job was processed successfully after worker restart!');
          console.log('\n=== QueueCTL Flow Verification Complete! All core features functional. ===');
          process.exit(0);
        } else {
          console.error('FAIL: Persistence job was not processed by restarted worker.');
          process.exit(1);
        }
      }, 2000);
    } else {
      console.error('FAIL: Job was not aborted or failed.');
      process.exit(1);
    }
  }, 3500);
}
