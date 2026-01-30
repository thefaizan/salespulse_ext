// SalesPulse Chrome Extension - Background Service Worker

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPEN_POPUP_WITH_DATA') {
    // Store the lead data for the popup to pick up (use local storage for temp data)
    chrome.storage.local.set({ pendingLeadData: message.data });

    // We can't programmatically open the popup, but we can update the badge
    // to indicate there's captured data ready
    chrome.action.setBadgeText({ text: '1' });
    chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
  }

  if (message.type === 'CHECK_FOR_UPDATES') {
    checkForUpdates().then(result => {
      sendResponse(result);
    });
    return true; // Keep channel open for async response
  }

  return true;
});

// Clear badge when popup is opened
chrome.action.onClicked.addListener((tab) => {
  chrome.action.setBadgeText({ text: '' });
});

// Listen for storage changes to clear pending data indicator
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.pendingLeadData) {
    if (!changes.pendingLeadData.newValue) {
      // Data was cleared, remove badge
      chrome.action.setBadgeText({ text: '' });
    }
  }
});

// On install/update, handle settings migration and setup
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    console.log('SalesPulse extension installed - v' + chrome.runtime.getManifest().version);

    // Check if there are settings in sync storage (from previous install)
    chrome.storage.sync.get(['baseUrl', 'apiToken'], (result) => {
      if (result.baseUrl && result.apiToken) {
        console.log('Found existing settings in sync storage - settings preserved!');
      } else {
        console.log('No existing settings found - fresh install');
      }
    });
  }

  if (details.reason === 'update') {
    const currentVersion = chrome.runtime.getManifest().version;
    const previousVersion = details.previousVersion;

    console.log(`SalesPulse extension updated from v${previousVersion} to v${currentVersion}`);

    // Migrate settings from local to sync storage if needed
    chrome.storage.local.get(['baseUrl', 'apiToken'], (localResult) => {
      if (localResult.baseUrl || localResult.apiToken) {
        chrome.storage.sync.get(['baseUrl', 'apiToken'], (syncResult) => {
          // Only migrate if sync storage is empty
          if (!syncResult.baseUrl && !syncResult.apiToken) {
            console.log('Migrating settings from local to sync storage...');
            chrome.storage.sync.set({
              baseUrl: localResult.baseUrl || '',
              apiToken: localResult.apiToken || ''
            }, () => {
              // Clear from local storage after migration
              chrome.storage.local.remove(['baseUrl', 'apiToken']);
              console.log('Settings migration complete');
            });
          }
        });
      }
    });

    // Clear dismissed version on update so user sees new update notifications
    chrome.storage.local.remove(['dismissedVersion']);
  }
});

// Check for updates
async function checkForUpdates() {
  try {
    // Get base URL from sync storage
    const result = await new Promise(resolve => {
      chrome.storage.sync.get(['baseUrl'], resolve);
    });

    if (!result.baseUrl) {
      return { success: false, reason: 'no_base_url' };
    }

    const base = result.baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${base}/api/v1/extensions/crm/version`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      return { success: false, reason: 'api_error' };
    }

    const data = await response.json();

    if (data.success && data.extension) {
      const currentVersion = chrome.runtime.getManifest().version;
      const latestVersion = data.extension.version;

      // Store update info
      await new Promise(resolve => {
        chrome.storage.local.set({
          latestVersion: latestVersion,
          downloadUrl: data.extension.download_url,
          lastUpdateCheck: Date.now()
        }, resolve);
      });

      // Compare versions
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

      if (hasUpdate) {
        // Show badge to indicate update available
        chrome.action.setBadgeText({ text: 'NEW' });
        chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
      }

      return {
        success: true,
        currentVersion,
        latestVersion,
        hasUpdate,
        downloadUrl: data.extension.download_url
      };
    }

    return { success: false, reason: 'invalid_response' };
  } catch (error) {
    console.error('Update check failed:', error);
    return { success: false, reason: 'network_error', error: error.message };
  }
}

function compareVersions(v1, v2) {
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

// Set up periodic update checking using alarms
chrome.alarms.create('checkForUpdates', {
  delayInMinutes: 5,        // First check after 5 minutes
  periodInMinutes: 60 * 6   // Then every 6 hours
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkForUpdates') {
    checkForUpdates();
  }
});

// Initial update check on startup (after 30 seconds)
setTimeout(() => {
  checkForUpdates();
}, 30000);
