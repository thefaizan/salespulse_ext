// SalesPulse Chrome Extension - Popup Script
// Shows connection status and user info only

class SalesPulsePopup {
  constructor() {
    this.apiUrl = '';
    this.apiToken = '';
    this.user = null;

    this.init();
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
      chrome.storage.local.get(['apiUrl', 'apiToken'], (result) => {
        this.apiUrl = result.apiUrl || '';
        this.apiToken = result.apiToken || '';
        resolve();
      });
    });
  }

  async saveSettings(apiUrl, apiToken) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ apiUrl, apiToken }, resolve);
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
      if (this.apiUrl) {
        // Extract base URL from API URL
        const baseUrl = this.apiUrl.replace(/\/api\/v1\/extensions\/crm\/?$/, '');
        chrome.tabs.create({ url: baseUrl || 'http://localhost:8000' });
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
      document.getElementById('api-url').value = this.apiUrl;
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
    const url = `${this.apiUrl}${endpoint}`;
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
    if (!this.apiUrl || !this.apiToken) {
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
    const apiUrl = document.getElementById('api-url').value.trim();
    const apiToken = document.getElementById('api-token').value.trim();

    if (!apiUrl || !apiToken) {
      this.showError('Please fill in both API URL and Token');
      return;
    }

    this.apiUrl = apiUrl;
    this.apiToken = apiToken;
    await this.saveSettings(apiUrl, apiToken);

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
    const baseUrl = this.apiUrl.replace(/\/api\/v1\/extensions\/crm\/?$/, '') || 'CRM Server';
    document.getElementById('api-endpoint').textContent = baseUrl;

    // Update CRM link
    document.getElementById('open-crm').href = baseUrl;
  }
}

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  new SalesPulsePopup();
});
