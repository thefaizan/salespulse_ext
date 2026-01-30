// SalesPulse Chrome Extension - Popup Script
// Shows connection status and user info only

class SalesPulsePopup {
  constructor() {
    this.baseUrl = '';
    this.apiToken = '';
    this.user = null;
    this.currentVersion = chrome.runtime.getManifest().version;
    this.latestVersion = null;
    this.downloadUrl = null;

    // API path is hardcoded
    this.apiPath = '/api/v1/extensions/crm';

    this.init();
  }

  // Get full API URL from base URL
  getApiUrl() {
    if (!this.baseUrl) return '';
    // Remove trailing slash from base URL if present
    const base = this.baseUrl.replace(/\/+$/, '');
    return `${base}${this.apiPath}`;
  }

  async init() {
    await this.loadSettings();
    this.bindEvents();
    await this.checkConnection();
    await this.checkForUpdates();
    this.updateUI();
  }

  // Storage helpers - using chrome.storage.sync for persistence across reinstalls
  async loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['baseUrl', 'apiToken'], (result) => {
        this.baseUrl = result.baseUrl || '';
        this.apiToken = result.apiToken || '';
        resolve();
      });
    });
  }

  async saveSettings(baseUrl, apiToken) {
    return new Promise((resolve) => {
      chrome.storage.sync.set({ baseUrl, apiToken }, resolve);
    });
  }

  // Check for extension updates
  async checkForUpdates() {
    if (!this.baseUrl) return;

    try {
      const base = this.baseUrl.replace(/\/+$/, '');
      const response = await fetch(`${base}${this.apiPath}/version`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.extension) {
          this.latestVersion = data.extension.version;
          this.downloadUrl = data.extension.download_url;

          // Store update info for background checking
          chrome.storage.local.set({
            latestVersion: this.latestVersion,
            downloadUrl: this.downloadUrl,
            lastUpdateCheck: Date.now()
          });
        }
      }
    } catch (error) {
      console.log('Update check failed:', error.message);
    }
  }

  isUpdateAvailable() {
    if (!this.latestVersion) return false;
    return this.compareVersions(this.latestVersion, this.currentVersion) > 0;
  }

  compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    return 0;
  }

  // Event bindings
  bindEvents() {
    // Settings button
    document.getElementById('settings-btn').addEventListener('click', () => {
      this.showView('settings');
    });

    // Save settings
    document.getElementById('save-settings').addEventListener('click', async () => {
      await this.handleSaveSettings();
    });

    // Test connection
    document.getElementById('test-connection').addEventListener('click', async () => {
      await this.testConnection();
    });

    // Go to settings from not connected view
    document.getElementById('goto-settings').addEventListener('click', () => {
      this.showView('settings');
    });

    // Close error
    document.getElementById('close-error').addEventListener('click', () => {
      this.hideError();
    });

    // Open CRM link
    document.getElementById('open-crm').addEventListener('click', (e) => {
      e.preventDefault();
      if (this.baseUrl) {
        chrome.tabs.create({ url: this.baseUrl });
      }
    });

    // Download update button
    const downloadBtn = document.getElementById('download-update');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (this.downloadUrl) {
          chrome.tabs.create({ url: this.downloadUrl });
        }
      });
    }

    // Dismiss update button
    const dismissBtn = document.getElementById('dismiss-update');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        document.getElementById('update-banner').classList.add('hidden');
        // Remember dismissal for this version
        chrome.storage.local.set({ dismissedVersion: this.latestVersion });
      });
    }
  }

  // View management
  showView(viewName) {
    const views = ['settings-view', 'not-connected-view', 'main-view'];
    views.forEach(v => {
      document.getElementById(v).classList.add('hidden');
    });

    document.getElementById(`${viewName}-view`).classList.remove('hidden');

    // Populate settings fields when showing settings
    if (viewName === 'settings') {
      document.getElementById('api-url').value = this.baseUrl;
      document.getElementById('api-token').value = this.apiToken;
    }
  }

  showLoading(show = true) {
    const loading = document.getElementById('loading');
    if (show) {
      loading.classList.remove('hidden');
    } else {
      loading.classList.add('hidden');
    }
  }

  showError(message) {
    const errorEl = document.getElementById('error-message');
    document.getElementById('error-text').textContent = message;
    errorEl.classList.remove('hidden');

    // Auto-hide after 5 seconds
    setTimeout(() => this.hideError(), 5000);
  }

  hideError() {
    document.getElementById('error-message').classList.add('hidden');
  }

  // API methods
  async apiRequest(endpoint, options = {}) {
    const url = `${this.getApiUrl()}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${this.apiToken}`
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers: { ...headers, ...options.headers }
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || data.error || 'API request failed');
      }

      return data;
    } catch (error) {
      if (error.name === 'TypeError' && error.message === 'Failed to fetch') {
        throw new Error('Cannot connect to server. Make sure the CRM is running.');
      }
      throw error;
    }
  }

  async checkConnection() {
    if (!this.baseUrl || !this.apiToken) {
      this.user = null;
      return false;
    }

    try {
      const data = await this.apiRequest('/verify', { method: 'POST' });
      this.user = data.user;
      return true;
    } catch (error) {
      this.user = null;
      return false;
    }
  }

  // Settings handlers
  async handleSaveSettings() {
    let baseUrl = document.getElementById('api-url').value.trim();
    const apiToken = document.getElementById('api-token').value.trim();

    if (!baseUrl || !apiToken) {
      this.showError('Please fill in both CRM Base URL and Token');
      return;
    }

    // Normalize base URL - remove trailing slashes and any API path if user accidentally included it
    baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/api\/v1\/extensions\/crm\/?$/, '');

    this.baseUrl = baseUrl;
    this.apiToken = apiToken;
    await this.saveSettings(baseUrl, apiToken);

    // Test the connection
    await this.testConnection();
  }

  async testConnection() {
    const statusEl = document.getElementById('connection-status');
    statusEl.classList.remove('hidden', 'success', 'error');

    this.showLoading(true);

    try {
      const connected = await this.checkConnection();

      if (connected) {
        statusEl.classList.add('success');
        statusEl.textContent = `Connected as ${this.user.name}`;

        // Also check for updates after successful connection
        await this.checkForUpdates();

        // After short delay, go to main view
        setTimeout(() => {
          this.updateUI();
        }, 1000);
      } else {
        statusEl.classList.add('error');
        statusEl.textContent = 'Connection failed. Check your credentials.';
      }
    } catch (error) {
      statusEl.classList.add('error');
      statusEl.textContent = error.message;
    } finally {
      this.showLoading(false);
    }
  }

  // UI update
  async updateUI() {
    if (!this.user) {
      this.showView('not-connected');
      return;
    }

    this.showView('main');

    // Update user info
    const initials = this.user.name
      .split(' ')
      .map(w => w[0])
      .join('')
      .toUpperCase()
      .substring(0, 2);

    document.getElementById('user-avatar').textContent = initials;
    document.getElementById('user-name').textContent = this.user.name;

    // Update API endpoint display
    document.getElementById('api-endpoint').textContent = this.baseUrl || 'CRM Server';

    // Update CRM link
    document.getElementById('open-crm').href = this.baseUrl;

    // Update version display
    const versionEl = document.getElementById('extension-version');
    if (versionEl) {
      versionEl.textContent = `v${this.currentVersion}`;
    }

    // Show update banner if update is available
    const updateBanner = document.getElementById('update-banner');
    if (updateBanner && this.isUpdateAvailable()) {
      // Check if user dismissed this version
      const result = await new Promise(resolve => {
        chrome.storage.local.get(['dismissedVersion'], resolve);
      });

      if (result.dismissedVersion !== this.latestVersion) {
        document.getElementById('new-version').textContent = this.latestVersion;
        updateBanner.classList.remove('hidden');
      }
    }
  }
}

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  new SalesPulsePopup();
});
