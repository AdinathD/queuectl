import React, { useState, useEffect } from 'react';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001/api';

function App() {
  const [stats, setStats] = useState({ jobs: {}, workersCount: 0, workers: [] });
  const [jobs, setJobs] = useState([]);
  const [config, setConfig] = useState({ max_retries: 3, backoff_base: 2 });
  const [activeTab, setActiveTab] = useState('all');

  // Enqueue form state
  const [newCommand, setNewCommand] = useState('');
  const [newJobId, setNewJobId] = useState('');
  const [newRunAt, setNewRunAt] = useState('');
  const [enqueueing, setEnqueueing] = useState(false);

  // Config edit state
  const [editMaxRetries, setEditMaxRetries] = useState('');
  const [editBackoffBase, setEditBackoffBase] = useState('');
  const [editTimeout, setEditTimeout] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);

  // Status message
  const [message, setMessage] = useState({ text: '', type: '' });

  const showMessage = (text, type = 'info') => {
    setMessage({ text, type });
    setTimeout(() => setMessage({ text: '', type: '' }), 5000);
  };

  const fetchData = async () => {
    try {
      // Fetch stats, jobs, and config in parallel using axios
      const [statsRes, jobsRes, configRes] = await Promise.all([
        axios.get(`${API_BASE}/stats`),
        axios.get(`${API_BASE}/jobs`),
        axios.get(`${API_BASE}/config`)
      ]);

      setStats(statsRes.data);
      setJobs(jobsRes.data);
      setConfig(configRes.data);

      if (editMaxRetries === '') setEditMaxRetries(configRes.data.max_retries);
      if (editBackoffBase === '') setEditBackoffBase(configRes.data.backoff_base);
      if (editTimeout === '') setEditTimeout(configRes.data.timeout || 30);
    } catch (err) {
      console.error('Error fetching data from API:', err);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleEnqueue = async (e) => {
    e.preventDefault();
    if (!newCommand.trim()) return;
    setEnqueueing(true);

    let parsedRunAt = null;
    if (newRunAt.trim()) {
      const val = newRunAt.trim();
      if (/^\+?\d+$/.test(val)) {
        const secs = parseInt(val, 10);
        parsedRunAt = new Date(Date.now() + secs * 1000).toISOString();
      } else {
        const d = new Date(val);
        if (!isNaN(d.getTime())) {
          parsedRunAt = d.toISOString();
        } else {
          showMessage(`Invalid scheduled time format. Use seconds (e.g. 10) or standard datetime string.`, 'error');
          setEnqueueing(false);
          return;
        }
      }
    }

    try {
      const res = await axios.post(`${API_BASE}/enqueue`, {
        command: newCommand,
        id: newJobId.trim() || undefined,
        run_at: parsedRunAt || undefined
      });
      showMessage(`Successfully enqueued job ${res.data.id}`, 'success');
      setNewCommand('');
      setNewJobId('');
      setNewRunAt('');
      fetchData();
    } catch (err) {
      const errMsg = err.response?.data?.error || 'Failed to enqueue job';
      showMessage(errMsg, 'error');
    } finally {
      setEnqueueing(false);
    }
  };

  const handleRetryJob = async (id) => {
    try {
      await axios.post(`${API_BASE}/retry`, { id });
      showMessage(`Job ${id} sent back to queue`, 'success');
      fetchData();
    } catch (err) {
      const errMsg = err.response?.data?.error || 'Failed to retry job';
      showMessage(errMsg, 'error');
    }
  };

  const handleSaveConfig = async (e) => {
    e.preventDefault();
    setSavingConfig(true);
    try {
      const p1 = axios.post(`${API_BASE}/config`, { key: 'max-retries', value: editMaxRetries });
      const p2 = axios.post(`${API_BASE}/config`, { key: 'backoff-base', value: editBackoffBase });
      const p3 = axios.post(`${API_BASE}/config`, { key: 'timeout', value: editTimeout });
      await Promise.all([p1, p2, p3]);
      showMessage('Configuration updated successfully', 'success');
      fetchData();
    } catch (err) {
      showMessage('Error saving configuration', 'error');
    } finally {
      setSavingConfig(false);
    }
  };

  const filteredJobs = jobs.filter(j => activeTab === 'all' || j.state === activeTab);

  const getStatusBadgeClass = (state) => {
    switch (state) {
      case 'pending': return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
      case 'processing': return 'text-blue-400 bg-blue-500/10 border-blue-500/20';
      case 'completed': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
      case 'failed': return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
      case 'dead': return 'text-red-500 bg-red-500/10 border-red-500/20';
      default: return 'text-slate-400 bg-slate-500/10 border-slate-500/20';
    }
  };

  const getStatValueColor = (state) => {
    switch (state) {
      case 'pending': return 'text-amber-400';
      case 'processing': return 'text-blue-400';
      case 'completed': return 'text-emerald-400';
      case 'failed': return 'text-rose-400';
      case 'dead': return 'text-red-500';
      default: return 'text-slate-400';
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-10">

      {/* Header */}
      <header className="flex justify-between items-center mb-10">
        <div>
          <h1 className="m-0 text-4xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-blue-600">
            QueueCTL Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-400">Real-time CLI Background Job Queue Monitor</p>
        </div>
        <div className="flex items-center gap-2 bg-white/5 px-4 py-2 rounded-full border border-white/5">
          <span className="w-2.5 h-2.5 rounded-full pulse-indicator bg-emerald-500"></span>
          <span className="text-xs font-semibold text-emerald-500">Live Connection Active</span>
        </div>
      </header>

      {/* Notification Toast */}
      {message.text && (
        <div className={`fixed top-5 right-5 px-6 py-3 rounded-lg z-50 shadow-2xl border-l-4 text-white transition-all duration-300 ${message.type === 'success' ? 'bg-emerald-800 border-emerald-500' : message.type === 'error' ? 'bg-red-800 border-red-500' : 'bg-blue-800 border-blue-500'
          }`}>
          {message.text}
        </div>
      )}

      {/* Stats Cards grid */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-5 mb-8">
        {['pending', 'processing', 'completed', 'failed', 'dead'].map(stateKey => (
          <div key={stateKey} className="glass-panel rounded-2xl p-5 text-center">
            <div className="text-xs text-slate-400 font-medium capitalize">{stateKey === 'dead' ? 'Dead (DLQ)' : stateKey}</div>
            <div className={`text-3xl font-extrabold my-2 ${getStatValueColor(stateKey)}`}>
              {stats.jobs[stateKey] || 0}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">

        {/* Left Side: Jobs List */}
        <div className="lg:col-span-2">
          <div className="glass-panel rounded-2xl p-6">
            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 mb-6">
              <h2 className="m-0 text-lg font-semibold text-white">Queue Jobs</h2>
              <div className="flex flex-wrap gap-1 bg-black/35 p-1 rounded-lg">
                {['all', 'pending', 'processing', 'completed', 'failed', 'dead'].map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`border-none px-3 py-1.5 rounded-md text-xs font-medium capitalize cursor-pointer transition-all ${activeTab === tab ? 'bg-white/10 text-blue-400' : 'text-slate-400 hover:text-white'
                      }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-slate-400">
                    <th className="py-3 px-2 font-semibold">Job ID</th>
                    <th className="py-3 px-2 font-semibold">Command</th>
                    <th className="py-3 px-2 font-semibold">State</th>
                    <th className="py-3 px-2 font-semibold">Retries</th>
                    <th className="py-3 px-2 font-semibold">Run At</th>
                    <th className="py-3 px-2 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredJobs.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="py-10 text-center text-slate-500 font-medium">
                        No jobs found in this state.
                      </td>
                    </tr>
                  ) : (
                    filteredJobs.map(job => (
                      <tr key={job.id} className="border-b border-white/5 hover:bg-white/5 transition-colors duration-200">
                        <td className="py-3.5 px-2 font-bold text-slate-200">{job.id}</td>
                        <td className="py-3.5 px-2 font-mono text-xs text-slate-300 max-w-[200px] truncate" title={job.command}>
                          {job.command}
                        </td>
                        <td className="py-3.5 px-2">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${getStatusBadgeClass(job.state)}`}>
                            {job.state}
                          </span>
                        </td>
                        <td className="py-3.5 px-2 text-slate-400">{job.attempts} / {job.max_retries}</td>
                        <td className="py-3.5 px-2 text-slate-500 text-xs">
                          {new Date(job.run_at).toLocaleTimeString()}
                        </td>
                        <td className="py-3.5 px-2 text-right">
                          {job.state === 'dead' && (
                            <button
                              onClick={() => handleRetryJob(job.id)}
                              className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-2.5 py-1 rounded transition-colors duration-150 cursor-pointer"
                            >
                              Retry
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Side: Control Panels */}
        <div className="space-y-8">

          {/* Active Workers Panel */}
          <div className="glass-panel rounded-2xl p-5">
            <h3 className="m-0 mb-4 text-base font-semibold text-white">Active Workers</h3>
            {stats.workers.length === 0 ? (
              <div className="text-slate-500 text-sm text-center py-4">
                No active workers connected.
              </div>
            ) : (
              <div className="space-y-2.5">
                {stats.workers.map(w => (
                  <div key={w.pid} className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/5">
                    <div>
                      <div className="font-bold text-slate-200 text-xs">PID {w.pid}</div>
                      <div className="text-[10px] text-slate-500">Seen: {new Date(w.last_seen).toLocaleTimeString()}</div>
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">
                      {w.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quick Enqueue Form */}
          <div className="glass-panel rounded-2xl p-5">
            <h3 className="m-0 mb-4 text-base font-semibold text-white">Enqueue Job</h3>
            <form onSubmit={handleEnqueue} className="space-y-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5 font-medium">Shell Command</label>
                <input
                  type="text"
                  placeholder="e.g. echo 'Hello World'"
                  value={newCommand}
                  onChange={(e) => setNewCommand(e.target.value)}
                  required
                  className="w-full bg-black/25 border border-white/10 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none px-3.5 py-2 rounded-lg text-white text-sm transition-all"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5 font-medium">Custom ID (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. my-job-123"
                  value={newJobId}
                  onChange={(e) => setNewJobId(e.target.value)}
                  className="w-full bg-black/25 border border-white/10 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none px-3.5 py-2 rounded-lg text-white text-sm transition-all"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5 font-medium">Scheduled Run At (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. 10 (for 10s delay) or YYYY-MM-DD HH:MM"
                  value={newRunAt}
                  onChange={(e) => setNewRunAt(e.target.value)}
                  className="w-full bg-black/25 border border-white/10 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none px-3.5 py-2 rounded-lg text-white text-sm transition-all"
                />
              </div>
              <button
                type="submit"
                disabled={enqueueing}
                className="w-full bg-gradient-to-r from-blue-500 to-blue-700 hover:from-blue-600 hover:to-blue-800 disabled:opacity-50 text-white font-semibold text-sm py-2.5 px-4 rounded-lg shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 transition-all cursor-pointer border-none"
              >
                {enqueueing ? 'Enqueueing...' : 'Enqueue Job'}
              </button>
            </form>
          </div>

          {/* Configurations Form */}
          <div className="glass-panel rounded-2xl p-5">
            <h3 className="m-0 mb-4 text-base font-semibold text-white">Queue Settings</h3>
            <form onSubmit={handleSaveConfig} className="space-y-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5 font-medium">Max Retries</label>
                <input
                  type="number"
                  value={editMaxRetries}
                  onChange={(e) => setEditMaxRetries(e.target.value)}
                  min="0"
                  required
                  className="w-full bg-black/25 border border-white/10 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none px-3.5 py-2 rounded-lg text-white text-sm transition-all"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5 font-medium">Backoff Base (seconds)</label>
                <input
                  type="number"
                  value={editBackoffBase}
                  onChange={(e) => setEditBackoffBase(e.target.value)}
                  min="1"
                  required
                  className="w-full bg-black/25 border border-white/10 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none px-3.5 py-2 rounded-lg text-white text-sm transition-all"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5 font-medium">Job Timeout (seconds)</label>
                <input
                  type="number"
                  value={editTimeout}
                  onChange={(e) => setEditTimeout(e.target.value)}
                  min="1"
                  required
                  className="w-full bg-black/25 border border-white/10 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none px-3.5 py-2 rounded-lg text-white text-sm transition-all"
                />
              </div>
              <button
                type="submit"
                disabled={savingConfig}
                className="w-full bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-slate-200 font-semibold text-sm py-2.5 px-4 rounded-lg transition-all cursor-pointer"
              >
                {savingConfig ? 'Saving...' : 'Update Settings'}
              </button>
            </form>
          </div>

        </div>

      </div>

    </div>
  );
}

export default App;
