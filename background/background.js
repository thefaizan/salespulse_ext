// SalesPulse Chrome Extension - Background Service Worker

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPEN_POPUP_WITH_DATA') {
    // Store the lead data for the popup to pick up
    chrome.storage.local.set({ pendingLeadData: message.data });

    // We can't programmatically open the popup, but we can update the badge
    // to indicate there's captured data ready
    chrome.action.setBadgeText({ text: '1' });
    chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
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

// On install, set up initial state
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Set default values
    chrome.storage.local.set({
      apiUrl: 'http://localhost:8000/api/v1/extensions/crm',
      apiToken: ''
    });

    console.log('SalesPulse extension installed');
  }
});
