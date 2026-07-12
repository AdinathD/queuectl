const express = require('express');
const cors = require('cors');
const { getStats, listJobs, enqueueJob, retryDlqJob } = require('./queue');
const { getConfig, setConfigKey } = require('./config');

function startServer(port = 3001) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use((req, res, next) => {
    console.log(`[API Server] ${req.method} ${req.path}`);
    next();
  });

  // GET stats
  app.get('/api/stats', (req, res) => {
    try {
      const stats = getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET jobs (with optional state filter)
  app.get('/api/jobs', (req, res) => {
    try {
      const { state } = req.query;
      const jobs = listJobs(state || null);
      res.json(jobs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST enqueue job
  app.post('/api/enqueue', (req, res) => {
    try {
      const { command, id, run_at } = req.body;
      if (!command) {
        return res.status(400).json({ error: 'Command is required.' });
      }
      const job = enqueueJob(command, id || null, run_at || null);
      res.status(201).json(job);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST retry a DLQ job
  app.post('/api/retry', (req, res) => {
    try {
      const { id } = req.body;
      if (!id) {
        return res.status(400).json({ error: 'Job ID is required.' });
      }
      const job = retryDlqJob(id);
      res.json(job);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET configs
  app.get('/api/config', (req, res) => {
    try {
      const config = getConfig();
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST set config
  app.post('/api/config', (req, res) => {
    try {
      const { key, value } = req.body;
      if (!key || value === undefined) {
        return res.status(400).json({ error: 'Key and value are required.' });
      }
      const updated = setConfigKey(key, value);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(port, () => {
    console.log(`[API Server] QueueCTL Dashboard API running on http://localhost:${port}`);
  });
}

module.exports = startServer;
