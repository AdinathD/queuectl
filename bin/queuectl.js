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

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM' || err.code === 'EINVAL';
  }
}


function readActivePids(pidsFile) {
  if (!fs.existsSync(pidsFile)) return [];
  try {
    const filePids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
    return filePids.filter(pid => isProcessAlive(pid));
  } catch (_) {
    return [];
  }
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
    let cleanedArg = rawArg;

    // Strip wrapping single or double quotes added by Windows shells
    if (cleanedArg.startsWith("'") && cleanedArg.endsWith("'")) {
      cleanedArg = cleanedArg.slice(1, -1).trim();
    }
    if (cleanedArg.startsWith('"') && cleanedArg.endsWith('"')) {
      cleanedArg = cleanedArg.slice(1, -1).trim();
    }

    let cmd = rawArg;
    let id = null;
    let runAtVal = options.runAt;

    // Try parsing JSON if it starts with '{' and ends with '}'
    if (cleanedArg.startsWith('{') && cleanedArg.endsWith('}')) {
      try {
        let parsed;
        try {
          parsed = JSON.parse(cleanedArg);
        } catch (e) {
          // Simple quote healer for basic JSON command structures
          const healed = cleanedArg
            .replace(/([{,])\s*([a-zA-Z0-9_-]+)\s*:/g, '$1"$2":') // Quote keys
            .replace(/:\s*([^,}]+)/g, ':"$1"');                  // Quote values
          parsed = JSON.parse(healed);
        }

        if (parsed.command) {
          cmd = parsed.command;
        }
        if (parsed.id) {
          id = parsed.id;
        }
        const runAtField = parsed.run_at || parsed['run-at'] || parsed['--run-at'];
        if (runAtField && !runAtVal) {
          runAtVal = runAtField;
        }
      } catch (e) {
        // Fallback to treating entire rawArg as a string command
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
    const workerPath = path.join(__dirname, '../src/worker.js');
    const pidsFile = path.join(DB_DIR, 'workers.pids');

    const existingPids = readActivePids(pidsFile);

    if (count === 1) {
      console.log(`Starting worker in the foreground (PID: ${process.pid})...`);
      fs.writeFileSync(pidsFile, JSON.stringify([...existingPids, process.pid]));

      const { runWorker } = require('../src/worker');
      runWorker();
    } else {
      console.log(`Starting ${count} workers in the foreground...`);
      const children = [];
      const spawnedPids = [];

      for (let i = 0; i < count; i++) {
        const child = fork(workerPath, [], {
          stdio: 'inherit'
        });
        children.push(child);
        spawnedPids.push(child.pid);
      }

      fs.writeFileSync(pidsFile, JSON.stringify([...existingPids, ...spawnedPids]));
      console.log(`Workers started with PIDs: ${spawnedPids.join(', ')}`);

      let exitCount = 0;
      const handleSignal = (signal) => {
        console.log(`\n[Parent Process] Received ${signal}. Shutting down workers gracefully...`);
        // SIGINT is broadcasted to the process group automatically by the terminal/OS.
        // We only need to propagate other signals like SIGTERM manually.
        if (signal !== 'SIGINT') {
          children.forEach(child => {
            try {
              child.kill(signal);
            } catch (_) { }
          });
        }
      };
      //ctrc c
      process.on('SIGINT', () => handleSignal('SIGINT'));

      //failsafe in case the parent process is targeted from diff terminal using pid
      process.on('SIGTERM', () => handleSignal('SIGTERM'));
      process.on('SIGBREAK', () => handleSignal('SIGBREAK'));

      children.forEach(child => {
        child.on('exit', () => {
          exitCount++;
          if (exitCount === children.length) {
            console.log('All workers terminated. Exiting parent.');
            process.exit(0);
          }
        });
      });
    }
  });

worker
  .command('stop')
  .description('Stop all running worker processes gracefully')
  .action(() => {
    console.log('Stopping workers gracefully...');
    const pidsFile = path.join(DB_DIR, 'workers.pids');
    let pids = readActivePids(pidsFile);

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

    //only flagging for failsafe, signal should ideally stop worker
    //in case signal fails in some edge cases
    //worker will exit on next poll if not stopped by signal so it wont hang forever

    // Mark workers for shutdown in database transaction
    const { transaction } = require('../src/db');
    transaction((db) => {
      if (db.activeWorkers) {
        pids.forEach(pid => {
          if (db.activeWorkers[pid] && isProcessAlive(pid)) {
            db.activeWorkers[pid].shutdown_requested = true;
          }
        });
      }
    });

    let sentSignalsCount = 0;
    pids.forEach(pid => {
      if (isProcessAlive(pid)) {
        try {
          const sig = process.platform === 'win32' ? 'SIGBREAK' : 'SIGTERM';
          console.log(`Sending ${sig} to worker ${pid}...`);
          process.kill(pid, sig);
          sentSignalsCount++;
        } catch (_) { }
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
  .option('--json', 'Output in JSON format')
  .action((options) => {
    const jobs = listJobs(options.state);

    if (options.json) {
      console.log(JSON.stringify(jobs, null, 2));
      return;
    }

    if (jobs.length === 0) {
      console.log('No matching jobs found.');
      return;
    }

    console.log('=== Jobs List ===');
    jobs.forEach(j => {
      console.log(`- ID: ${j.id}`);
      console.log(`  Command:  "${j.command}"`);
      console.log(`  State:    ${j.state}`);
      console.log(`  Attempts: ${j.attempts}/${j.max_retries}`);
      console.log(`  Created:  ${j.created_at}`);
      console.log('--------------------------------------------------');
    });
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
