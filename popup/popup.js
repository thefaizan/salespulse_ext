// SalesPulse Chrome Extension - Popup Script
// Shows connection status and user info only

class SalesPulsePopup {
  constructor() {
    this.baseUrl = '';
    this.apiToken = '';
    this.user = null;

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
    this.updateUI();
  }

  // Storage helpers
  async loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['baseUrl', 'apiToken'], (result) => {
        this.baseUrl = result.baseUrl || '';
        this.apiToken = result.apiToken || '';
        resolve();
      });
    });
  }

  async saveSettings(baseUrl, apiToken) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ baseUrl, apiToken }, resolve);
    });
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
  updateUI() {
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
  }
}

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  new SalesPulsePopup();
});
