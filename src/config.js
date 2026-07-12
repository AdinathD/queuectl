const { transaction } = require('./db');

const DEFAULT_CONFIG = {
  max_retries: 3,
  backoff_base: 2,
  timeout: 30
};

function getConfig() {
  return transaction((db) => {
    if (!db.config) {
      db.config = { ...DEFAULT_CONFIG };
    }
    return { ...DEFAULT_CONFIG, ...db.config };
  });
}

function setConfigKey(key, value) {
  return transaction((db) => {
    if (!db.config) {
      db.config = { ...DEFAULT_CONFIG };
    }
    // Clean key and parse numeric values if needed
    const normalizedKey = key.replace('-', '_');
    const parsedVal = Number(value);
    db.config[normalizedKey] = isNaN(parsedVal) ? value : parsedVal;
    return db.config;
  });
}

module.exports = {
  getConfig,
  setConfigKey
};
