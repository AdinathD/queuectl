#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Simple .env file loader
try {
  const envPath = path.join(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf8');
    env.split(/\r?\n/).forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        process.env[key] = value.trim();
      }
    });
  }
} catch (e) { }

const { fork } = require('child_process');
const { program } = require('commander');
const inquirer = require('inquirer');
const { enqueueJob, listJobs, getStats, retryDlqJob } = require('../src/queue');
const { setConfigKey } = require('../src/config');
const { DB_DIR } = require('../src/db');

function parseRunAt(val) {
  if (!val) return null;
  val = val.trim();

  // If it's a simple number (seconds delay)
  if (/^\+?\d+$/.test(val)) {
    const amount = parseInt(val, 10);
    return new Date(Date.now() + amount * 1000).toISOString();
  }

  // Try parsing as standard date
  const parsedDate = new Date(val);
  if (!isNaN(parsedDate.getTime())) {
    return parsedDate.toISOString();
  }

  throw new Error(`Invalid run_at value: "${val}". Expected ISO timestamp or delay in seconds.`);
}

program
  .name('queuectl')
  .description('QueueCTL - CLI Background Job Queue System')
  .version('1.0.0');

// 1. Enqueue command
program
  .command('enqueue [command]')
  .description('Add a new job to the queue')
  .option('--run-at <datetime>', 'Schedule the job to run at a specific time (ISO timestamp or delay in seconds)')
  .action(async (commandArg, options) => {
    let rawArg = commandArg;
    if (!rawArg) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'command',
          message: 'Enter the command (or JSON string) to enqueue:',
          validate: (input) => input.trim().length > 0 || 'Command cannot be empty.'
        }
      ]);
      rawArg = answers.command;
    }

    rawArg = rawArg.trim();
    let cmd = rawArg;
    let id = null;
    let runAtVal = options.runAt;

    // Try parsing JSON if it starts with '{' and ends with '}'
    if (rawArg.startsWith('{') && rawArg.endsWith('}')) {
      try {
        const parsed = JSON.parse(rawArg);
        if (parsed.command) {
          cmd = parsed.command;
        }
        if (parsed.id) {
          id = parsed.id;
        }
        if (parsed.run_at && !runAtVal) {
          runAtVal = parsed.run_at;
        }
      } catch (e) {
        // Not valid JSON, treat the whole argument as a string command
      }
    }

    try {
      const parsedRunAt = parseRunAt(runAtVal);
      const job = enqueueJob(cmd, id, parsedRunAt);
      console.log(`Enqueued job successfully:`);
      console.log(JSON.stringify(job, null, 2));
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// 2. Worker command group
const worker = program.command('worker').description('Manage background workers');

worker
  .command('start')
  .description('Start one or more background workers')
  .option('-c, --count <count>', 'Number of background workers to start', (val) => parseInt(val, 10), 1)
  .action((options) => {
    const count = options.count;
    console.log(`Starting ${count} worker(s)...`);

    const workerPath = path.join(__dirname, '../src/worker.js');
    const spawnedPids = [];

    for (let i = 0; i < count; i++) {
      const child = fork(workerPath, [], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref(); // Let parent CLI process exit
      spawnedPids.push(child.pid);
    }

    const pidsFile = path.join(DB_DIR, 'workers.pids');
    let existingPids = [];
    if (fs.existsSync(pidsFile)) {
      try {
        existingPids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
      } catch (_) { }
    }
    fs.writeFileSync(pidsFile, JSON.stringify([...existingPids, ...spawnedPids]));

    console.log(`Started workers with PIDs: ${spawnedPids.join(', ')}`);
  });

worker
  .command('stop')
  .description('Stop all running worker processes gracefully')
  .action(() => {
    console.log('Stopping workers gracefully...');
    const pidsFile = path.join(DB_DIR, 'workers.pids');
    let pids = [];

    if (fs.existsSync(pidsFile)) {
      try {
        pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
      } catch (_) { }
    }

    // Fallback: Check active workers in database stats
    const stats = getStats();
    if (stats.workers && stats.workers.length > 0) {
      stats.workers.forEach(w => {
        if (w.pid && !pids.includes(w.pid)) {
          pids.push(w.pid);
        }
      });
    }

    if (pids.length === 0) {
      console.log('No running workers found.');
      return;
    }

    let sentSignalsCount = 0;
    pids.forEach(pid => {
      try {
        // Check if process exists
        process.kill(pid, 0);
        console.log(`Sending SIGTERM to worker ${pid}...`);
        process.kill(pid, 'SIGTERM');
        sentSignalsCount++;
      } catch (err) {
        if (err.code === 'EPERM') {
          try {
            console.log(`Sending SIGTERM to worker ${pid}...`);
            process.kill(pid, 'SIGTERM');
            sentSignalsCount++;
          } catch (_) { }
        }
      }
    });

    // Clear the pids list
    fs.writeFileSync(pidsFile, JSON.stringify([]));
    if (sentSignalsCount > 0) {
      console.log('Stop signals sent to all active workers.');
    } else {
      console.log('No running worker processes were found to stop.');
    }
  });

// 3. Status command
program
  .command('status')
  .description('Show summary of all job states and active workers')
  .action(() => {
    const stats = getStats();
    console.log('=== Queue Status ===');
    console.log(`Pending:    ${stats.jobs.pending}`);
    console.log(`Processing: ${stats.jobs.processing}`);
    console.log(`Completed:  ${stats.jobs.completed}`);
    console.log(`Failed:     ${stats.jobs.failed}`);
    console.log(`Dead (DLQ): ${stats.jobs.dead}`);
    console.log('\n=== Active Workers ===');
    console.log(`Count: ${stats.workersCount}`);
    if (stats.workers.length > 0) {
      stats.workers.forEach(w => {
        console.log(`- PID ${w.pid}: ${w.status}`);
      });
    } else {
      console.log('No active workers logged in the last 10 seconds.');
    }
  });

// 4. List command
program
  .command('list')
  .description('List jobs (optionally filtered by state)')
  .option('--state <state>', 'Filter jobs by state')
  .action((options) => {
    const jobs = listJobs(options.state);
    console.log(JSON.stringify(jobs, null, 2));
  });

// 5. DLQ command group
const dlq = program.command('dlq').description('Manage the Dead Letter Queue (DLQ)');

dlq
  .command('list')
  .description('List all dead-lettered (permanently failed) jobs')
  .action(() => {
    const deadJobs = listJobs('dead');
    console.log(JSON.stringify(deadJobs, null, 2));
  });

dlq
  .command('retry [jobId]')
  .description('Move a dead-lettered job back to the pending queue')
  .action(async (jobId) => {
    let id = jobId;
    if (!id) {
      const deadJobs = listJobs('dead');
      if (deadJobs.length === 0) {
        console.log('No dead-lettered jobs in the queue to retry.');
        return;
      }
      const choices = deadJobs.map(j => ({
        name: `ID: ${j.id} | Command: "${j.command}" (attempts: ${j.attempts})`,
        value: j.id
      }));
      const answers = await inquirer.prompt([
        {
          type: 'list',
          name: 'jobId',
          message: 'Select a dead job to retry:',
          choices: choices
        }
      ]);
      id = answers.jobId;
    }

    try {
      const job = retryDlqJob(id);
      console.log(`Job ${job.id} successfully reset and returned to pending state.`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// 6. Config command group
const configCmd = program.command('config').description('Manage configurations');

configCmd
  .command('set [key] [value]')
  .description('Manage configurations (e.g. max-retries, backoff-base, timeout)')
  .action(async (key, value) => {
    let configKey = key;
    let configVal = value;

    if (!configKey) {
      const answers = await inquirer.prompt([
        {
          type: 'list',
          name: 'key',
          message: 'Select the configuration key to set:',
          choices: [
            { name: 'max-retries (Maximum number of retries before moving to DLQ)', value: 'max-retries' },
            { name: 'backoff-base (Base number of seconds for exponential backoff)', value: 'backoff-base' },
            { name: 'timeout (Maximum execution time for a job in seconds)', value: 'timeout' }
          ]
        }
      ]);
      configKey = answers.key;
    }

    if (!configVal) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'value',
          message: `Enter the value for ${configKey}:`,
          validate: (input) => input.trim().length > 0 || 'Value cannot be empty.'
        }
      ]);
      configVal = answers.value;
    }

    const updated = setConfigKey(configKey, configVal);
    console.log('Configuration updated successfully:');
    console.log(JSON.stringify(updated, null, 2));
  });

// 7. Dashboard command
program
  .command('dashboard')
  .description('Start the web dashboard API server')
  .option('-p, --port <port>', 'Port to run the dashboard server on', (val) => parseInt(val, 10), parseInt(process.env.BACKEND_PORT || process.env.PORT, 10) || 3001)
  .action((options) => {
    const startServer = require('../src/server');
    startServer(options.port);
  });

// 8. UI command
program
  .command('ui')
  .description('Start the frontend dashboard development server (npm run dev)')
  .action(() => {
    console.log('Starting frontend dashboard development server (npm run dev)...');
    const { spawn } = require('child_process');
    spawn('npm', ['run', 'dev'], {
      cwd: path.join(__dirname, '../dashboard'),
      stdio: 'inherit',
      shell: true
    });
  });

// Parse commands
program.parse(process.argv);
