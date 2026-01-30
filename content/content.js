// SalesPulse Chrome Extension - Content Script for Freelancer.com

class SalesPulseInjector {
  constructor() {
    this.baseUrl = '';
    this.apiToken = '';
    this.stages = [];
    this.currencies = [];
    this.baseCurrency = 'USD';
    this.buttonInjected = false;
    this.observerActive = false;
    this.profileDataCache = {};
    this.existingLead = null;
    this.isEditMode = false;
    this.isOtherOwner = false;
    this.otherOwnerName = '';
    this.currentChatUrl = '';
    this.currentUsername = ''; // For widget-based lead checking
    this.currentWidgetBtnContainer = null; // Reference to current widget button container
    this.contextInvalidated = false;
    this.isWidgetMode = false; // Track if we're working with chat widget
    this.widgetData = null; // Data extracted from chat widget
    this.pendingChatWidgetForBack = null; // Chat widget to return to after modal closes
    this.listBadgeDebounceTimer = null; // Debounce timer for list badge updates
    this.listBadgeProcessing = false; // Flag to prevent concurrent processing

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
    this.injectStyles();
    this.observePageChanges();
    this.tryInjectButton();
    this.tryInjectWidgetButtons();
    this.tryInjectListBadges();
  }

  async loadSettings() {
    // If already loaded, return cached values
    if (this.baseUrl && this.apiToken) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      try {
        // Check if chrome.storage is still available (extension context valid)
        // Use chrome.storage.sync for settings persistence across reinstalls
        if (!chrome?.storage?.sync) {
          console.warn('SalesPulse: Extension context invalidated. Please refresh the page.');
          this.contextInvalidated = true;
          resolve();
          return;
        }

        chrome.storage.sync.get(['baseUrl', 'apiToken'], (result) => {
          if (chrome.runtime.lastError) {
            console.warn('SalesPulse: Extension context invalidated. Please refresh the page.');
            this.contextInvalidated = true;
            resolve();
            return;
          }
          this.baseUrl = result.baseUrl || '';
          this.apiToken = result.apiToken || '';
          resolve();
        });
      } catch (error) {
        console.warn('SalesPulse: Extension context invalidated. Please refresh the page.');
        this.contextInvalidated = true;
        resolve();
      }
    });
  }

  // Watch for page changes (Freelancer uses SPA navigation)
  observePageChanges() {
    if (this.observerActive) return;
    this.observerActive = true;

    const observer = new MutationObserver(() => {
      this.tryInjectButton();
      this.tryInjectWidgetButtons(); // Also check for chat widgets
      this.tryInjectListBadges(); // Also update list badges
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Also check on URL changes (for SPA chat switching)
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        console.log('SalesPulse: URL changed from', lastUrl, 'to', location.href);
        lastUrl = location.href;

        // Remove existing button completely
        this.removeButton();

        // Reset state
        this.buttonInjected = false;
        this.existingLead = null;
        this.isEditMode = false;
        this.isOtherOwner = false;
        this.otherOwnerName = '';
        this.currentChatUrl = '';
        this.currentUsername = '';

        // Re-inject button with fresh state
        this.tryInjectButton();
      }

      // Also check for new chat widgets periodically
      this.tryInjectWidgetButtons();

      // Also check for list badge updates
      this.tryInjectListBadges();
    }, 500); // Check more frequently for smoother UX
  }

  // Inject badges into the message list (left column)
  tryInjectListBadges() {
    // Debounce to prevent excessive API calls
    if (this.listBadgeDebounceTimer) {
      clearTimeout(this.listBadgeDebounceTimer);
    }

    this.listBadgeDebounceTimer = setTimeout(() => {
      this.processListBadges();
    }, 300);
  }

  // Process list badges (actual implementation)
  async processListBadges() {
    // Only inject on messages pages
    if (!location.pathname.includes('/messages')) return;

    // Don't proceed if no API credentials
    if (!this.baseUrl || !this.apiToken) return;

    // Prevent concurrent processing
    if (this.listBadgeProcessing) return;
    this.listBadgeProcessing = true;

    try {
      // Find all thread list items that don't have badges yet
      const threadItems = document.querySelectorAll('fl-list-item[fltrackinglabel="MessagingThreadListItem"]');
      if (threadItems.length === 0) {
        return;
      }

      // Collect usernames that need checking
      const usernamesToCheck = [];
      const itemsToProcess = [];

      threadItems.forEach(item => {
        // Skip if already has a badge container
        if (item.querySelector('.salespulse-list-badge-container')) return;

        // Find the username in the thread item
        const usernameEl = item.querySelector('app-messaging-thread-list-item-name p:not(.Name)');
        if (!usernameEl) return;

        const usernameText = usernameEl.textContent.trim();
        if (!usernameText.startsWith('@')) return;

        const username = usernameText.substring(1); // Remove @ prefix
        if (!username) return;

        usernamesToCheck.push(username);
        itemsToProcess.push({ item, username });
      });

      if (usernamesToCheck.length === 0) return;

      // Add loading badges first
      itemsToProcess.forEach(({ item, username }) => {
        this.addListLoadingBadge(item, username);
      });

      // Batch check leads
      const response = await fetch(`${this.getApiUrl()}/leads/batch-check?${usernamesToCheck.map(u => `usernames[]=${encodeURIComponent(u)}`).join('&')}`, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.results) {
          // Update badges with actual data
          itemsToProcess.forEach(({ item, username }) => {
            const result = data.results[username];
            this.updateListBadge(item, username, result);
          });
        }
      } else {
        // Remove loading badges on error
        itemsToProcess.forEach(({ item }) => {
          const badge = item.querySelector('.salespulse-list-badge-container');
          if (badge) badge.remove();
        });
      }
    } catch (error) {
      console.error('SalesPulse: Error batch checking leads:', error);
    } finally {
      this.listBadgeProcessing = false;
    }
  }

  // Force refresh list badges (e.g., after saving a lead)
  refreshListBadges() {
    // Remove all existing badges to force refresh
    const badges = document.querySelectorAll('.salespulse-list-badge-container');
    badges.forEach(badge => badge.remove());

    // Re-process badges
    this.listBadgeProcessing = false;
    this.tryInjectListBadges();
  }

  // Add loading badge to a list item
  addListLoadingBadge(item, username) {
    // Find the container where we'll add the badge
    const subtitleContainer = item.querySelector('.Container.Subtitle');
    if (!subtitleContainer) return;

    // Check if badge already exists
    if (item.querySelector('.salespulse-list-badge-container')) return;

    const badgeContainer = document.createElement('div');
    badgeContainer.className = 'salespulse-list-badge-container';
    badgeContainer.dataset.username = username;
    badgeContainer.innerHTML = `
      <span class="salespulse-list-loading-badge">
        <span class="sp-list-spinner"></span>
      </span>
    `;

    subtitleContainer.appendChild(badgeContainer);
  }

  // Update list badge with actual data
  updateListBadge(item, username, result) {
    let badgeContainer = item.querySelector('.salespulse-list-badge-container');

    if (!badgeContainer) {
      // Create container if doesn't exist
      const subtitleContainer = item.querySelector('.Container.Subtitle');
      if (!subtitleContainer) return;

      badgeContainer = document.createElement('div');
      badgeContainer.className = 'salespulse-list-badge-container';
      badgeContainer.dataset.username = username;
      subtitleContainer.appendChild(badgeContainer);
    }

    if (!result || !result.exists) {
      // Lead doesn't exist - show Fresh badge
      badgeContainer.innerHTML = `
        <span class="salespulse-list-fresh-badge" title="New lead - not yet saved to CRM">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
          </svg>
          Fresh
        </span>
      `;
    } else {
      // Lead exists - show stage badge and owner
      const stageBadge = result.stage ? `
        <span class="salespulse-list-stage-badge" style="background-color: ${result.stage.color || '#6b7280'}" title="Lead Stage: ${this.escapeHtml(result.stage.name)}">
          ${this.escapeHtml(result.stage.name)}
        </span>
      ` : '';

      const ownerBadge = result.owner_first_name ? `
        <span class="salespulse-list-owner-badge" title="Assigned to ${this.escapeHtml(result.owner_first_name)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
          ${this.escapeHtml(result.owner_first_name)}
        </span>
      ` : '';

      badgeContainer.innerHTML = stageBadge + ownerBadge;
    }
  }

  // Remove the injected button
  removeButton() {
    const btnContainer = document.getElementById('salespulse-btn-container');
    if (btnContainer) {
      btnContainer.remove();
      console.log('SalesPulse: Removed existing button');
    }
  }

  // Inject buttons into floating chat widgets
  tryInjectWidgetButtons() {
    // Find all chat widget context boxes (more reliable than finding app-messaging-chat)
    const contextBoxes = document.querySelectorAll('app-messaging-context-box .ContextBox-topContextButtons');

    contextBoxes.forEach((topContextButtons, index) => {
      try {
        // Check if button already exists in this context box
        if (topContextButtons.querySelector('.salespulse-widget-btn-container')) {
          return; // Skip, already has button
        }

        // Find the parent app-messaging-context-box first
        const contextBoxElement = topContextButtons.closest('app-messaging-context-box');
        if (!contextBoxElement) {
          return;
        }

        // Find the parent chat widget - IMPORTANT: Use app-messaging-chat-contents FIRST
        // because pre-loaded/minimized chats don't have app-messaging-chat wrapper
        // but BOTH types have app-messaging-chat-contents
        const chatWidget = contextBoxElement.closest('app-messaging-chat-contents') ||
                          contextBoxElement.closest('app-messaging-chat-box') ||
                          contextBoxElement.closest('.ChatBox') ||
                          contextBoxElement.closest('app-messaging-chat');

        if (!chatWidget) {
          return;
        }

        // Find username from the chat widget header - be specific to avoid finding wrong chat
        // Look for the header within THIS chat widget only
        const header = chatWidget.querySelector('app-messaging-header');
        let usernameLink = null;

        if (header) {
          usernameLink = header.querySelector('a[href*="/u/"]');
        }

        // Fallback: search in the chat widget directly
        if (!usernameLink) {
          usernameLink = chatWidget.querySelector('a[href*="/u/"]');
        }

        if (!usernameLink) {
          return;
        }

        const usernameMatch = usernameLink.getAttribute('href').match(/\/u\/([^\/\?\&]+)/);
        if (!usernameMatch) {
          return;
        }

        const username = usernameMatch[1];

        // Extract widget data NOW while we have the correct context
        // This is crucial - we store it on the button container to avoid re-extraction issues
        const widgetDataAtInjection = this.extractWidgetDataAtInjection(chatWidget, contextBoxElement, username);

        // Note: Chat URL is not available in the widget DOM without opening the details panel
        // which causes bad UX. We leave it empty - user can manually add it if needed.

        // Create the button container with a unique ID
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'salespulse-widget-btn-container ContextBox-topContextButton';
        buttonContainer.id = `salespulse-widget-${username}-${Date.now()}`;
        buttonContainer.dataset.username = username;
        // Store the extracted data on the button container
        buttonContainer.dataset.widgetData = JSON.stringify(widgetDataAtInjection);
        buttonContainer.innerHTML = `
          <button class="salespulse-widget-btn salespulse-loading-btn" data-username="${this.escapeHtml(username)}" disabled>
            <div class="salespulse-btn-spinner"></div>
            Checking...
          </button>
        `;

        // Insert as first child of the top context buttons container
        topContextButtons.insertBefore(buttonContainer, topContextButtons.firstChild);

        console.log('SalesPulse: Injected widget button for', username, 'with data:', widgetDataAtInjection);

        // Use the chat widget for modal context (already found the correct one)
        const widgetForModal = chatWidget;

        // Check for existing lead and update button state (async, non-blocking)
        this.checkExistingLeadForWidget(widgetForModal, username, buttonContainer);

        // Bind click event - use stored data, don't re-find widget
        const btn = buttonContainer.querySelector('button');
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();

          // Find the button container from the clicked element
          const clickedBtnContainer = e.target.closest('.salespulse-widget-btn-container');

          // Get username from the button's data attribute (stored at injection time)
          const btnUsername = clickedBtnContainer?.dataset.username || username;

          // Check if this is Edit mode (has existing lead data)
          const isEditMode = !!(clickedBtnContainer?.dataset.existingLead);

          // Navigate UP from the button container to find the correct chat widget
          // IMPORTANT: Use app-messaging-chat-contents FIRST because pre-loaded chats
          // don't have app-messaging-chat wrapper, but BOTH types have app-messaging-chat-contents
          const clickedContextBox = clickedBtnContainer?.closest('app-messaging-context-box');
          let currentWidget = null;

          if (clickedContextBox) {
            // From context box, go up to find the chat widget
            // Use app-messaging-chat-contents FIRST to avoid finding wrong chat
            currentWidget = clickedContextBox.closest('app-messaging-chat-contents') ||
                           clickedContextBox.closest('app-messaging-chat-box') ||
                           clickedContextBox.closest('.ChatBox') ||
                           clickedContextBox.closest('app-messaging-chat');
          }

          // Fallback: try from the click target directly
          if (!currentWidget) {
            currentWidget = e.target.closest('app-messaging-chat-contents') ||
                           e.target.closest('app-messaging-chat-box') ||
                           e.target.closest('.ChatBox') ||
                           e.target.closest('app-messaging-chat');
          }

          // Log widget data from button container for debugging
          console.log('SalesPulse: Click handler - btnContainer found:', !!clickedBtnContainer, 'isEditMode:', isEditMode);
          if (clickedBtnContainer) {
            const storedWidgetData = clickedBtnContainer.dataset.widgetData;
            console.log('SalesPulse: Click handler - username:', btnUsername, 'widget found:', !!currentWidget, 'hasWidgetData:', !!storedWidgetData);
          }

          // For Save Lead (NOT Edit Lead), try to extract chat URL by opening details panel
          let extractedChatUrl = null;
          if (!isEditMode && currentWidget) {
            extractedChatUrl = await this.extractChatUrlFromDetailsPanel(currentWidget);
          }

          // Update widget data with extracted chat URL if found
          if (extractedChatUrl && clickedBtnContainer?.dataset.widgetData) {
            try {
              const widgetData = JSON.parse(clickedBtnContainer.dataset.widgetData);
              widgetData.chatUrl = extractedChatUrl;
              clickedBtnContainer.dataset.widgetData = JSON.stringify(widgetData);
              console.log('SalesPulse: Updated widget data with extracted chat URL:', extractedChatUrl);
            } catch (err) {
              console.error('SalesPulse: Error updating widget data with chat URL:', err);
            }
          }

          this.showWidgetModal(currentWidget, btnUsername, clickedBtnContainer);
        });
      } catch (err) {
        console.error('SalesPulse: Error injecting widget button:', err);
      }
    });
  }

  // Extract widget data at injection time when we have the correct DOM context
  // This is more reliable than trying to find the data later on click
  extractWidgetDataAtInjection(chatWidget, contextBox, username) {
    const data = {
      customerName: username,
      freelancerUsername: username,
      projectTitle: '',
      chatUrl: '',
      projectUrl: '',
      country: '',
      joinedDate: ''
    };

    // The header should be within the same chat widget structure
    // Try multiple approaches to find the project link

    // First, look within the chat widget we found
    let projectLink = null;
    let searchContext = chatWidget;

    // Try to find app-messaging-header within the chat widget
    const header = chatWidget.querySelector('app-messaging-header');
    if (header) {
      projectLink = header.querySelector('a[href*="/projects/"]');
      if (!projectLink) {
        // Try fl-link with secondary title
        const secondaryLink = header.querySelector('fl-link[fltrackinglabel="ChatboxHeaderSecondaryTitle"] a');
        if (secondaryLink) projectLink = secondaryLink;
      }
    }

    // Fallback: search in the contextBox's parent structure
    if (!projectLink && contextBox) {
      const chatContents = contextBox.closest('app-messaging-chat-contents');
      if (chatContents) {
        const headerInContents = chatContents.querySelector('app-messaging-header');
        if (headerInContents) {
          projectLink = headerInContents.querySelector('a[href*="/projects/"]');
        }
      }
    }

    // Fallback: look for any project link in the chat widget
    if (!projectLink) {
      projectLink = chatWidget.querySelector('a[href*="/projects/"]');
    }

    if (projectLink) {
      data.projectTitle = projectLink.textContent.trim();
      data.projectUrl = projectLink.href;
    }

    // Extract customer DISPLAY NAME from header
    // The display name is different from the username - it's the actual name shown above/beside @username
    // Try multiple selectors for different chat states (expanded, minimized, etc.)
    let customerNameFound = false;

    // Try 1: Look for display name text element (NOT the @username link)
    // The display name is typically in a separate element from the username link
    if (header) {
      // Look for fl-text or span elements that contain the display name
      // Common patterns: .Header-details-name, fl-text with name content, etc.
      const displayNameSelectors = [
        '.Header-details-name',
        '.Header-name',
        '.ChatHeader-name',
        '[class*="displayName"]',
        '[class*="DisplayName"]',
        'fl-text[class*="name"]',
        '.NameContainer .font-bold'
      ];

      for (const selector of displayNameSelectors) {
        const nameEl = header.querySelector(selector);
        if (nameEl) {
          // Get text content but exclude username links
          let text = '';
          for (const node of nameEl.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
              text += node.textContent.trim();
            } else if (node.nodeType === Node.ELEMENT_NODE && !node.matches('a[href*="/u/"]')) {
              // Get text from child elements that are not username links
              const childText = node.textContent.trim();
              if (childText && !childText.startsWith('@')) {
                text += childText;
              }
            }
          }
          text = text.trim();
          if (text && text !== '@' && text.length > 1 && text !== username) {
            data.customerName = text;
            customerNameFound = true;
            console.log('SalesPulse: Found display name via selector:', selector, ':', text);
            break;
          }
        }
      }
    }

    // Try 2: Look for fl-link with MessagingHeaderDisplayNameLink - get the TEXT content
    // This element might contain the display name as text, not just the @username
    if (!customerNameFound) {
      const displayNameFlLink = chatWidget.querySelector('fl-link[fltrackinglabel="MessagingHeaderDisplayNameLink"]');
      if (displayNameFlLink) {
        // Check if there's text content outside the <a> tag
        let text = '';
        for (const node of displayNameFlLink.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent.trim();
          }
        }
        // Also try getting text from the link itself (it might be a display name, not @username)
        if (!text) {
          const linkText = displayNameFlLink.textContent.trim();
          // Only use if it doesn't look like a username
          if (linkText && !linkText.startsWith('@') && linkText !== username) {
            text = linkText;
          }
        }
        if (text && text !== '@' && text.length > 1) {
          data.customerName = text;
          customerNameFound = true;
          console.log('SalesPulse: Found display name via MessagingHeaderDisplayNameLink:', text);
        }
      }
    }

    // Try 3: Look for the first fl-link in header that contains display name (not username)
    if (!customerNameFound && header) {
      const headerLinks = header.querySelectorAll('fl-link');
      for (const flLink of headerLinks) {
        const linkEl = flLink.querySelector('a');
        if (linkEl) {
          const href = linkEl.getAttribute('href') || '';
          const text = linkEl.textContent.trim();
          // If it's a user profile link, check if text looks like a display name
          if (href.includes('/u/') && text && !text.startsWith('@') && text !== username) {
            data.customerName = text;
            customerNameFound = true;
            console.log('SalesPulse: Found display name via fl-link:', text);
            break;
          }
        }
      }
    }

    // Try 4: Header username link in app-messaging-header (fallback to @username extraction)
    if (!customerNameFound) {
      let usernameLink = chatWidget.querySelector('app-messaging-header a[href*="/u/"]');
      if (usernameLink) {
        const text = usernameLink.textContent.trim();
        if (text && text !== '@') {
          data.customerName = text.startsWith('@') ? text.substring(1) : text;
          customerNameFound = true;
          console.log('SalesPulse: Found name via header username link:', data.customerName);
        }
      }
    }

    // Try 5: Look in the header for any username text element
    if (!customerNameFound) {
      const headerEl = chatWidget.querySelector('app-messaging-header');
      if (headerEl) {
        const headerText = headerEl.querySelector('.Header-details-username, .Header-username, [class*="username"]');
        if (headerText) {
          const text = headerText.textContent.trim();
          if (text && text !== '@') {
            data.customerName = text.startsWith('@') ? text.substring(1) : text;
            customerNameFound = true;
          }
        }
      }
    }

    // Try 6: Search in contextBox's parent for username
    if (!customerNameFound && contextBox) {
      const chatContents = contextBox.closest('app-messaging-chat-contents');
      if (chatContents) {
        const usernameLink = chatContents.querySelector('a[href*="/u/"]');
        if (usernameLink) {
          const text = usernameLink.textContent.trim();
          if (text && text !== '@') {
            data.customerName = text.startsWith('@') ? text.substring(1) : text;
            customerNameFound = true;
          }
        }
      }
    }

    // Try 7: Look anywhere in the widget for username link text
    if (!customerNameFound) {
      const allUsernameLinks = chatWidget.querySelectorAll('a[href*="/u/"]');
      for (const link of allUsernameLinks) {
        const text = link.textContent.trim();
        if (text && text !== '@' && text.length > 1) {
          data.customerName = text.startsWith('@') ? text.substring(1) : text;
          customerNameFound = true;
          break;
        }
      }
    }

    // Final fallback: use username as customer name
    if (!customerNameFound || !data.customerName) {
      data.customerName = username;
    }

    console.log('SalesPulse: Extracted customer name for', username, ':', data.customerName, '(found via search:', customerNameFound, ')');

    // Note: Chat URL extraction moved to extractChatUrlFromDetailsPanel for reliability
    // Extract chat URL - look for "Open in full screen" link which contains /messages/thread/{id}
    // The link is inside .OpenChatInInbox container with fl-link[fltrackinglabel="OpenChatInInbox-link"]
    let chatUrlLink = null;

    // Primary: Look for the OpenChatInInbox link (most reliable)
    const openInInbox = chatWidget.querySelector('.OpenChatInInbox a[href*="/messages/thread/"]');
    if (openInInbox) {
      chatUrlLink = openInInbox;
    }

    // Fallback: Look for fl-link with OpenChatInInbox-link tracking label
    if (!chatUrlLink) {
      chatUrlLink = chatWidget.querySelector('fl-link[fltrackinglabel="OpenChatInInbox-link"] a');
    }

    // Fallback: Look in app-messaging-chat-details
    if (!chatUrlLink) {
      const chatDetails = chatWidget.querySelector('app-messaging-chat-details');
      if (chatDetails) {
        chatUrlLink = chatDetails.querySelector('a[href*="/messages/thread/"]');
        if (!chatUrlLink) {
          chatUrlLink = chatDetails.querySelector('.OpenChatInInbox a');
        }
      }
    }

    // Fallback: search in parent app-messaging-chat-contents
    if (!chatUrlLink && contextBox) {
      const chatContents = contextBox.closest('app-messaging-chat-contents');
      if (chatContents) {
        chatUrlLink = chatContents.querySelector('.OpenChatInInbox a[href*="/messages/thread/"]');
        if (!chatUrlLink) {
          chatUrlLink = chatContents.querySelector('a[href*="/messages/thread/"]');
        }
      }
    }

    // Fallback: search anywhere in the chat widget for messages/thread link
    if (!chatUrlLink) {
      chatUrlLink = chatWidget.querySelector('a[href*="/messages/thread/"]');
    }

    // Final fallback: look for any link with /messages/thread/ pattern
    if (!chatUrlLink) {
      const allMessageLinks = chatWidget.querySelectorAll('a[href*="/messages/"]');
      for (const link of allMessageLinks) {
        const href = link.getAttribute('href');
        if (href && href.match(/\/messages\/thread\/\d+/)) {
          chatUrlLink = link;
          break;
        }
      }
    }

    if (chatUrlLink) {
      const href = chatUrlLink.getAttribute('href');
      // Convert to full URL if relative
      if (href.startsWith('/')) {
        data.chatUrl = 'https://www.freelancer.com' + href;
      } else {
        data.chatUrl = chatUrlLink.href;
      }
      console.log('SalesPulse: Found chat URL for', username, ':', data.chatUrl);
    } else {
      console.log('SalesPulse: Could not find chat URL for', username);
    }

    return data;
  }

  // Extract chat URL by programmatically opening the details panel
  // This is used for Save Lead (not Edit Lead) to get the full chat URL
  async extractChatUrlFromDetailsPanel(chatWidget) {
    if (!chatWidget) return null;

    console.log('SalesPulse: Attempting to extract chat URL from details panel...');

    try {
      // Find the 3 dots button (more options button) - it's an fl-icon, not fl-button!
      // It has fltrackinglabel="OpenSettingsChatBox" and contains ui-more-vert icon
      let moreButton = chatWidget.querySelector('fl-icon[fltrackinglabel="OpenSettingsChatBox"]');

      if (!moreButton) {
        // Fallback: find fl-icon with ui-more-vert icon anywhere in the widget
        const flIcons = chatWidget.querySelectorAll('fl-icon');
        for (const icon of flIcons) {
          const iconSpan = icon.querySelector('span[data-name="ui-more-vert"], .IconContainer[data-name="ui-more-vert"]');
          if (iconSpan) {
            moreButton = icon;
            break;
          }
        }
      }

      if (!moreButton) {
        console.log('SalesPulse: Could not find 3 dots button (fl-icon with OpenSettingsChatBox)');
        return null;
      }

      console.log('SalesPulse: Found 3 dots button, clicking to open details panel...');

      // Click the fl-icon element to open details panel
      moreButton.click();

      // Wait for the details panel to appear and find the chat URL
      let chatUrl = null;
      let attempts = 0;
      const maxAttempts = 20; // 2 seconds max wait

      while (!chatUrl && attempts < maxAttempts) {
        await this.sleep(100);
        attempts++;

        // Look for the "Open in full screen" link in the chat details panel
        // Structure: .OpenChatInInbox > fl-link[fltrackinglabel="OpenChatInInbox-link"] > a
        const detailsPanel = chatWidget.querySelector('app-messaging-chat-details');
        if (detailsPanel) {
          const openInFullScreenLink = detailsPanel.querySelector('.OpenChatInInbox fl-link[fltrackinglabel="OpenChatInInbox-link"] a') ||
                                       detailsPanel.querySelector('.OpenChatInInbox a[href*="/messages/thread/"]') ||
                                       detailsPanel.querySelector('a[href*="/messages/thread/"]');

          if (openInFullScreenLink) {
            const href = openInFullScreenLink.getAttribute('href');
            if (href && href.includes('/messages/thread/')) {
              // Convert to full URL if relative
              if (href.startsWith('/')) {
                chatUrl = 'https://www.freelancer.com' + href;
              } else {
                chatUrl = openInFullScreenLink.href;
              }
              console.log('SalesPulse: Found chat URL:', chatUrl);
            }
          }
        }
      }

      // Don't close the details panel yet - we'll close it when the modal is closed
      // Store the chat widget reference so we can click back button later
      this.pendingChatWidgetForBack = chatWidget;
      console.log('SalesPulse: Chat URL extracted, will return to chat after modal closes');

      return chatUrl;

    } catch (error) {
      console.error('SalesPulse: Error extracting chat URL from details panel:', error);
      return null;
    }
  }

  // Helper function for async delays
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Helper function to format date as "11 Sep 2025"
  formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return dateStr;
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const day = date.getDate();
      const month = months[date.getMonth()];
      const year = date.getFullYear();
      return `${day} ${month} ${year}`;
    } catch (e) {
      return dateStr;
    }
  }

  // Helper function to format datetime as "11 Sep 2025, 2:30 PM"
  formatDateTime(dateStr) {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return dateStr;
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const day = date.getDate();
      const month = months[date.getMonth()];
      const year = date.getFullYear();
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12;
      return `${day} ${month} ${year}, ${hours}:${minutes} ${ampm}`;
    } catch (e) {
      return dateStr;
    }
  }

  // Click the back button to return to chat view after modal closes
  clickBackButtonToReturnToChat() {
    if (!this.pendingChatWidgetForBack) {
      console.log('SalesPulse: No pending chat widget for back navigation');
      return;
    }

    const chatWidget = this.pendingChatWidgetForBack;
    this.pendingChatWidgetForBack = null; // Clear the reference immediately

    // Check if the chat widget is still in the DOM
    if (!document.contains(chatWidget)) {
      console.log('SalesPulse: Chat widget no longer in DOM, skipping back navigation');
      return;
    }

    // Check if the details panel is actually visible (we should only click back if it is)
    const detailsPanel = chatWidget.querySelector('app-messaging-chat-details');
    if (!detailsPanel) {
      console.log('SalesPulse: Details panel not found, already in chat view');
      return;
    }

    console.log('SalesPulse: Looking for back button with HeaderBackCta...');

    // Find the back button using the proper tracking label
    const backButton = chatWidget.querySelector('fl-icon[fltrackinglabel="HeaderBackCta"]');

    if (backButton) {
      console.log('SalesPulse: Found back button, clicking...');
      // Use setTimeout to avoid potential issues with Angular's change detection
      setTimeout(() => {
        try {
          // Simulate a proper click event
          const clickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window
          });
          backButton.dispatchEvent(clickEvent);
          console.log('SalesPulse: Dispatched click event on back button');
        } catch (err) {
          console.error('SalesPulse: Error clicking back button:', err);
        }
      }, 150);
    } else {
      console.log('SalesPulse: Could not find back button with HeaderBackCta');
    }
  }

  // Check if lead exists for a widget chat
  async checkExistingLeadForWidget(widget, username, buttonContainer) {
    const btn = buttonContainer.querySelector('button');

    if (!this.baseUrl || !this.apiToken) {
      this.updateWidgetButtonState(btn, 'save', null);
      return;
    }

    try {
      // Check by username since we don't have the chat URL
      const response = await fetch(`${this.getApiUrl()}/customers/check?freelancer_username=${encodeURIComponent(username)}`, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.exists && data.customer) {
          // Customer exists, check if they have recent leads
          const leads = data.customer.leads || [];
          if (leads.length > 0) {
            const lead = leads[0];

            // Check if this lead belongs to the current user or another user
            if (lead.is_owned_by_current_user) {
              // Lead belongs to current user - show Edit Lead
              buttonContainer.dataset.existingLead = JSON.stringify(lead);
              buttonContainer.dataset.existingCustomer = JSON.stringify(data.customer);
              this.updateWidgetButtonState(btn, 'edit', lead);
              console.log('SalesPulse: Found existing lead (owned by current user) for widget:', username);
            } else {
              // Lead belongs to another user - show owner's name
              buttonContainer.dataset.otherOwner = lead.owner_first_name || 'Other';
              this.updateWidgetButtonState(btn, 'other_owner', lead);
              console.log('SalesPulse: Lead owned by another user:', lead.owner_first_name, 'for widget:', username);
            }
            return;
          }
        }
      }
    } catch (error) {
      console.error('SalesPulse: Error checking lead for widget:', error);
    }

    this.updateWidgetButtonState(btn, 'save', null);
  }

  // Update widget button state (Save Lead, Edit Lead, or Other Owner)
  // mode: 'save', 'edit', or 'other_owner'
  updateWidgetButtonState(btn, mode, lead) {
    btn.classList.remove('salespulse-loading-btn');

    // Get the button container to add/update stage badge
    const btnContainer = btn.closest('.salespulse-widget-btn-container');

    if (mode === 'edit' && lead) {
      btn.disabled = false;
      btn.classList.add('salespulse-edit-btn');
      btn.classList.remove('salespulse-owner-btn');
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        Edit Lead
      `;

      // Add stage badge if lead has stage info
      if (btnContainer && lead.stage) {
        this.addStageBadge(btnContainer, lead.stage);
      }
    } else if (mode === 'other_owner' && lead) {
      // Lead belongs to another sales agent - show their name
      btn.disabled = true;
      btn.classList.remove('salespulse-edit-btn');
      btn.classList.add('salespulse-owner-btn');
      const ownerName = lead.owner_first_name || 'Other';
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
        ${this.escapeHtml(ownerName)}
      `;
      btn.title = `This lead is assigned to ${ownerName}`;

      // Add stage badge if lead has stage info
      if (btnContainer && lead.stage) {
        this.addStageBadge(btnContainer, lead.stage);
      }
    } else {
      btn.disabled = false;
      btn.classList.remove('salespulse-edit-btn');
      btn.classList.remove('salespulse-owner-btn');
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
        </svg>
        Save Lead
      `;

      // Remove stage badge if exists
      if (btnContainer) {
        const existingBadge = btnContainer.querySelector('.salespulse-stage-badge');
        if (existingBadge) {
          existingBadge.remove();
        }
      }
    }
  }

  // Add stage badge to widget button container
  addStageBadge(btnContainer, stage) {
    // Remove existing badge if any
    const existingBadge = btnContainer.querySelector('.salespulse-stage-badge');
    if (existingBadge) {
      existingBadge.remove();
    }

    // Create stage badge
    const badge = document.createElement('span');
    badge.className = 'salespulse-stage-badge';
    badge.style.backgroundColor = stage.color || '#6b7280';
    badge.textContent = stage.name || 'Unknown';
    badge.title = `Lead Stage: ${stage.name}`;

    // Insert badge after the button
    btnContainer.appendChild(badge);
  }

  // Show modal for widget chat
  async showWidgetModal(widget, username, btnContainer = null) {
    this.isWidgetMode = true;
    this.currentUsername = username;
    this.currentWidgetBtnContainer = btnContainer; // Store reference for later updates

    // Check if we have an existing lead (edit mode) from cached data
    let hasExistingLead = false;
    if (btnContainer && btnContainer.dataset.existingLead) {
      hasExistingLead = true;
    } else if (widget) {
      // Look for button container in THIS widget only
      // Use querySelector which finds within the element's descendants
      const widgetBtnContainer = widget.querySelector('.salespulse-widget-btn-container[data-username="' + username + '"]');
      if (widgetBtnContainer && widgetBtnContainer.dataset.existingLead) {
        hasExistingLead = true;
        btnContainer = widgetBtnContainer;
        this.currentWidgetBtnContainer = btnContainer;
      }
    }

    // Use pre-extracted widget data from button container (most reliable)
    // This data was captured at injection time when DOM context was correct
    if (btnContainer && btnContainer.dataset.widgetData) {
      try {
        this.widgetData = JSON.parse(btnContainer.dataset.widgetData);
        console.log('SalesPulse: Using stored widget data for', username, this.widgetData);
      } catch (e) {
        console.error('SalesPulse: Error parsing stored widget data', e);
        this.widgetData = this.extractWidgetData(widget, username, btnContainer);
      }
    } else {
      // Fallback to extraction (less reliable for minimized chats)
      console.log('SalesPulse: No stored widget data found, using extraction fallback for', username);
      this.widgetData = this.extractWidgetData(widget, username, btnContainer);
      console.log('SalesPulse: Extracted widget data:', this.widgetData);
    }

    // Remove existing modal (don't click back button - we're just preparing to show a new modal)
    this.hideModal(false);

    // Check context
    if (this.contextInvalidated) {
      this.showRefreshMessage();
      return;
    }

    // Load settings first
    await this.loadSettings();
    if (this.contextInvalidated) {
      this.showRefreshMessage();
      return;
    }

    // If in edit mode, always fetch fresh data from API
    if (hasExistingLead) {
      console.log('SalesPulse: Fetching fresh lead data for', username);
      await this.fetchFreshLeadData(username);
    } else {
      this.existingLead = null;
      this.isEditMode = false;
    }

    // Load stages, currencies and render modal
    await this.loadStages();
    await this.loadCurrencies();
    this.renderModal();
  }

  // Fetch fresh lead data from API for edit mode
  async fetchFreshLeadData(username) {
    try {
      const response = await fetch(`${this.getApiUrl()}/customers/check?freelancer_username=${encodeURIComponent(username)}`, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.exists && data.customer) {
          const leads = data.customer.leads || [];
          if (leads.length > 0) {
            const lead = leads[0];
            this.existingLead = {
              id: lead.id,
              title: lead.title,
              amount: lead.amount,
              currency: lead.currency || 'USD',
              description: lead.description,
              freelancer_chat_url: lead.freelancer_chat_url,
              project_url: lead.project_url,
              lead_stage_id: lead.lead_stage_id,
              stage: lead.stage,
              updated_at: lead.updated_at,
              customer: data.customer
            };
            this.isEditMode = true;

            // Update cached data in button container
            if (this.currentWidgetBtnContainer) {
              this.currentWidgetBtnContainer.dataset.existingLead = JSON.stringify(lead);
              this.currentWidgetBtnContainer.dataset.existingCustomer = JSON.stringify(data.customer);

              // Update stage badge
              const btn = this.currentWidgetBtnContainer.querySelector('button');
              if (btn && lead.stage) {
                this.addStageBadge(this.currentWidgetBtnContainer, lead.stage);
              }
            }

            console.log('SalesPulse: Fetched fresh lead data:', this.existingLead);
            return;
          }
        }
      }
    } catch (error) {
      console.error('SalesPulse: Error fetching fresh lead data:', error);
    }

    // If we couldn't fetch fresh data, fall back to cached data
    if (this.currentWidgetBtnContainer && this.currentWidgetBtnContainer.dataset.existingLead) {
      try {
        const existingLead = JSON.parse(this.currentWidgetBtnContainer.dataset.existingLead);
        const existingCustomer = JSON.parse(this.currentWidgetBtnContainer.dataset.existingCustomer);
        this.existingLead = {
          id: existingLead.id,
          title: existingLead.title,
          amount: existingLead.amount,
          currency: existingLead.currency || 'USD',
          description: existingLead.description,
          freelancer_chat_url: existingLead.freelancer_chat_url,
          project_url: existingLead.project_url,
          lead_stage_id: existingLead.lead_stage_id,
          stage: existingLead.stage,
          updated_at: existingLead.updated_at,
          customer: existingCustomer
        };
        this.isEditMode = true;
        console.log('SalesPulse: Using cached lead data as fallback');
      } catch (e) {
        this.existingLead = null;
        this.isEditMode = false;
      }
    } else {
      this.existingLead = null;
      this.isEditMode = false;
    }
  }

  // Extract data from chat widget (fallback when stored data not available)
  extractWidgetData(widget, username, btnContainer = null) {
    const data = {
      customerName: '',
      freelancerUsername: username,
      projectTitle: '',
      chatUrl: '', // Widget doesn't have direct chat URL
      projectUrl: '',
      country: '',
      joinedDate: ''
    };

    // Find the parent container that has the header info
    // Use btnContainer for more reliable navigation if available
    let chatContainer = null;

    if (btnContainer) {
      // Navigate from button container to find the chat container
      const contextBox = btnContainer.closest('app-messaging-context-box');
      if (contextBox) {
        chatContainer = contextBox.closest('app-messaging-chat') ||
                       contextBox.closest('app-messaging-chat-contents') ||
                       contextBox.closest('app-messaging-chat-box');
      }
    }

    // Fallback to widget-based lookup
    if (!chatContainer && widget) {
      chatContainer = widget.closest('app-messaging-chat') ||
                     widget.closest('app-messaging-chat-contents') ||
                     widget;
    }

    if (!chatContainer) {
      console.log('SalesPulse: Could not find chat container for', username);
      data.customerName = username;
      return data;
    }

    console.log('SalesPulse: Extracting data from chat container for', username);

    // Extract customer DISPLAY NAME from header (not just the @username)
    let customerNameFound = false;
    const header = chatContainer.querySelector('app-messaging-header');

    // Try 1: Look for display name text element (NOT the @username link)
    if (header) {
      const displayNameSelectors = [
        '.Header-details-name',
        '.Header-name',
        '.ChatHeader-name',
        '[class*="displayName"]',
        '[class*="DisplayName"]',
        'fl-text[class*="name"]',
        '.NameContainer .font-bold'
      ];

      for (const selector of displayNameSelectors) {
        const nameEl = header.querySelector(selector);
        if (nameEl) {
          let text = '';
          for (const node of nameEl.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
              text += node.textContent.trim();
            } else if (node.nodeType === Node.ELEMENT_NODE && !node.matches('a[href*="/u/"]')) {
              const childText = node.textContent.trim();
              if (childText && !childText.startsWith('@')) {
                text += childText;
              }
            }
          }
          text = text.trim();
          if (text && text !== '@' && text.length > 1 && text !== username) {
            data.customerName = text;
            customerNameFound = true;
            break;
          }
        }
      }
    }

    // Try 2: Look for fl-link with MessagingHeaderDisplayNameLink
    if (!customerNameFound) {
      const displayNameFlLink = chatContainer.querySelector('fl-link[fltrackinglabel="MessagingHeaderDisplayNameLink"]');
      if (displayNameFlLink) {
        const linkText = displayNameFlLink.textContent.trim();
        if (linkText && !linkText.startsWith('@') && linkText !== username) {
          data.customerName = linkText;
          customerNameFound = true;
        }
      }
    }

    // Try 3: Look for the first fl-link in header that contains display name
    if (!customerNameFound && header) {
      const headerLinks = header.querySelectorAll('fl-link');
      for (const flLink of headerLinks) {
        const linkEl = flLink.querySelector('a');
        if (linkEl) {
          const href = linkEl.getAttribute('href') || '';
          const text = linkEl.textContent.trim();
          if (href.includes('/u/') && text && !text.startsWith('@') && text !== username) {
            data.customerName = text;
            customerNameFound = true;
            break;
          }
        }
      }
    }

    // Try 4: Header username link (fallback)
    if (!customerNameFound) {
      const headerUsernameLink = chatContainer.querySelector('app-messaging-header a[href*="/u/"]');
      if (headerUsernameLink) {
        const text = headerUsernameLink.textContent.trim();
        if (text && text !== '@') {
          data.customerName = text.startsWith('@') ? text.substring(1) : text;
          customerNameFound = true;
        }
      }
    }

    // Try 5: Any username link in container
    if (!customerNameFound) {
      const nameLink = chatContainer.querySelector('a[href*="/u/"]');
      if (nameLink) {
        const text = nameLink.textContent.trim();
        if (text && text !== '@') {
          data.customerName = text.startsWith('@') ? text.substring(1) : text;
          customerNameFound = true;
        }
      }
    }

    // Final fallback: use username
    if (!customerNameFound || !data.customerName) {
      data.customerName = username;
    }

    // Extract project title and URL from header
    let projectLink = chatContainer.querySelector('app-messaging-header a[href*="/projects/"]');

    // Fallback: try fl-link with secondary title tracking label
    if (!projectLink) {
      const secondaryTitleLink = chatContainer.querySelector('fl-link[fltrackinglabel="ChatboxHeaderSecondaryTitle"] a');
      if (secondaryTitleLink) {
        projectLink = secondaryTitleLink;
      }
    }

    // Fallback: try Header-details-title
    if (!projectLink) {
      projectLink = chatContainer.querySelector('.Header-details-title a[href*="/projects/"]');
    }

    // Fallback: any project link in the container
    if (!projectLink) {
      projectLink = chatContainer.querySelector('a[href*="/projects/"]');
    }

    if (projectLink) {
      data.projectTitle = projectLink.textContent.trim();
      data.projectUrl = projectLink.href;
      console.log('SalesPulse: Found project for', username, ':', data.projectTitle);
    } else {
      console.log('SalesPulse: No project link found for', username);
    }

    // Leave chat URL empty for widget-based leads
    data.chatUrl = '';

    return data;
  }

  // Update widget button after saving a lead
  updateWidgetButtonAfterSave(username, lead, customer) {
    // Find button container by username data attribute directly - most reliable
    const btnContainer = document.querySelector(`.salespulse-widget-btn-container[data-username="${username}"]`);

    if (btnContainer) {
      // Update stored data
      btnContainer.dataset.existingLead = JSON.stringify(lead);
      btnContainer.dataset.existingCustomer = JSON.stringify(customer);

      // Update button state to show "Edit Lead"
      const btn = btnContainer.querySelector('button');
      if (btn) {
        this.updateWidgetButtonState(btn, true, lead);
      }

      console.log('SalesPulse: Updated widget button after save for', username);
      return;
    }

    // Fallback: search through all chat widgets (both types)
    const widgets = document.querySelectorAll('app-messaging-chat-contents, app-messaging-chat');

    for (const widget of widgets) {
      const usernameLink = widget.querySelector('a[href*="/u/"]');
      if (!usernameLink) continue;

      const match = usernameLink.getAttribute('href').match(/\/u\/([^\/\?\&]+)/);
      if (!match || match[1] !== username) continue;

      const widgetBtnContainer = widget.querySelector('.salespulse-widget-btn-container');
      if (!widgetBtnContainer) continue;

      // Update stored data
      widgetBtnContainer.dataset.existingLead = JSON.stringify(lead);
      widgetBtnContainer.dataset.existingCustomer = JSON.stringify(customer);

      // Update button state to show "Edit Lead"
      const btn = widgetBtnContainer.querySelector('button');
      if (btn) {
        this.updateWidgetButtonState(btn, true, lead);
      }

      console.log('SalesPulse: Updated widget button after save for', username);
      break;
    }
  }

  async tryInjectButton() {
    // Only inject on message thread pages
    if (!location.pathname.includes('/messages/')) return;
    if (this.buttonInjected) return;

    // Check if button already exists
    if (document.getElementById('salespulse-save-lead-btn')) {
      this.buttonInjected = true;
      return;
    }

    // Find the right sidebar - new UI structure
    const rightSidebar = document.querySelector('app-messaging-chat-details-redesign');
    if (!rightSidebar) return;

    // Find the CTA container (where "Create quote" button is)
    const ctaContainer = rightSidebar.querySelector('.ChatContext-cta-container');
    if (!ctaContainer) return;

    // Store current chat URL
    this.currentChatUrl = window.location.href;

    // Create the button container with loading state
    const buttonContainer = document.createElement('div');
    buttonContainer.id = 'salespulse-btn-container';
    buttonContainer.className = 'salespulse-cta-container';
    buttonContainer.innerHTML = `
      <button id="salespulse-save-lead-btn" class="salespulse-save-btn salespulse-loading-btn" disabled>
        <div class="salespulse-btn-spinner"></div>
        Checking...
      </button>
    `;

    // Insert after the CTA container
    ctaContainer.parentNode.insertBefore(buttonContainer, ctaContainer.nextSibling);
    this.buttonInjected = true;

    // Check if lead exists for this chat
    await this.checkExistingLead();

    // Update button based on result
    this.updateButtonState();

    // Bind click event
    document.getElementById('salespulse-save-lead-btn').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showModal();
    });

    console.log('SalesPulse: Button injected, edit mode:', this.isEditMode);
  }

  async checkExistingLead() {
    if (!this.baseUrl || !this.apiToken) {
      this.existingLead = null;
      this.isEditMode = false;
      this.isOtherOwner = false;
      return;
    }

    try {
      const response = await fetch(`${this.getApiUrl()}/leads/check?chat_url=${encodeURIComponent(this.currentChatUrl)}`, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.exists && data.lead) {
          this.existingLead = data.lead;

          // Check if this lead belongs to the current user or another user
          if (data.lead.is_owned_by_current_user) {
            this.isEditMode = true;
            this.isOtherOwner = false;
            console.log('SalesPulse: Found existing lead (owned by current user):', this.existingLead);
          } else {
            this.isEditMode = false;
            this.isOtherOwner = true;
            this.otherOwnerName = data.lead.owner_first_name || 'Other';
            console.log('SalesPulse: Lead owned by another user:', this.otherOwnerName);
          }
        } else {
          this.existingLead = null;
          this.isEditMode = false;
          this.isOtherOwner = false;
        }
      }
    } catch (error) {
      console.error('SalesPulse: Error checking for existing lead:', error);
      this.existingLead = null;
      this.isEditMode = false;
      this.isOtherOwner = false;
    }
  }

  updateButtonState() {
    const btn = document.getElementById('salespulse-save-lead-btn');
    if (!btn) return;

    const btnContainer = document.getElementById('salespulse-btn-container');

    btn.classList.remove('salespulse-loading-btn');

    if (this.isOtherOwner && this.existingLead) {
      // Lead belongs to another sales agent - show their name
      btn.disabled = true;
      btn.classList.remove('salespulse-edit-btn');
      btn.classList.add('salespulse-owner-btn');
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
        ${this.escapeHtml(this.otherOwnerName)}
      `;
      btn.title = `This lead is assigned to ${this.otherOwnerName}`;

      // Add stage badge if lead has stage info
      if (btnContainer && this.existingLead.stage) {
        this.addInboxStageBadge(btnContainer, this.existingLead.stage);
      }
    } else if (this.isEditMode && this.existingLead) {
      btn.disabled = false;
      btn.classList.add('salespulse-edit-btn');
      btn.classList.remove('salespulse-owner-btn');
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        Edit Lead
      `;

      // Add stage badge if lead has stage info
      if (btnContainer && this.existingLead.stage) {
        this.addInboxStageBadge(btnContainer, this.existingLead.stage);
      }
    } else {
      btn.disabled = false;
      btn.classList.remove('salespulse-edit-btn');
      btn.classList.remove('salespulse-owner-btn');
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
        </svg>
        Save Lead
      `;

      // Remove stage badge if exists
      if (btnContainer) {
        const existingBadge = btnContainer.querySelector('.salespulse-inbox-stage-badge');
        if (existingBadge) {
          existingBadge.remove();
        }
      }
    }
  }

  // Add stage badge to inbox button container (below button)
  addInboxStageBadge(btnContainer, stage) {
    // Remove existing badge if any
    const existingBadge = btnContainer.querySelector('.salespulse-inbox-stage-badge');
    if (existingBadge) {
      existingBadge.remove();
    }

    // Create stage badge container
    const badgeContainer = document.createElement('div');
    badgeContainer.className = 'salespulse-inbox-stage-badge';
    badgeContainer.innerHTML = `
      <span class="salespulse-inbox-stage-label">Lead Stage:</span>
      <span class="salespulse-inbox-stage-value" style="background-color: ${stage.color || '#6b7280'}">${this.escapeHtml(stage.name || 'Unknown')}</span>
    `;

    // Insert badge after the button
    btnContainer.appendChild(badgeContainer);
  }

  injectStyles() {
    if (document.getElementById('salespulse-styles')) return;

    const styles = document.createElement('style');
    styles.id = 'salespulse-styles';
    styles.textContent = `
      /* Save Lead Button in Sidebar */
      .salespulse-cta-container {
        padding: 0 16px;
        margin-bottom: 12px;
      }

      .salespulse-save-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        width: 100%;
        padding: 10px 16px;
        background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
        color: white;
        border: none;
        border-radius: 4px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        font-family: inherit;
      }

      .salespulse-save-btn:hover:not(:disabled) {
        opacity: 0.9;
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
      }

      .salespulse-save-btn:active:not(:disabled) {
        transform: translateY(0);
      }

      .salespulse-save-btn:disabled {
        opacity: 0.7;
        cursor: not-allowed;
      }

      .salespulse-save-btn svg {
        flex-shrink: 0;
      }

      /* Edit mode button - different color */
      .salespulse-edit-btn {
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      }

      .salespulse-edit-btn:hover:not(:disabled) {
        box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
      }

      /* Owner button - shows when lead belongs to another sales agent */
      .salespulse-save-btn.salespulse-owner-btn {
        background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
        cursor: default;
        opacity: 0.9;
      }

      .salespulse-save-btn.salespulse-owner-btn:hover {
        transform: none;
        box-shadow: none;
      }

      /* Loading button */
      .salespulse-loading-btn {
        background: #9ca3af;
      }

      /* Inbox Stage Badge */
      .salespulse-inbox-stage-badge {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        margin-top: 8px;
        padding: 6px 0;
      }

      .salespulse-inbox-stage-label {
        font-size: 11px;
        color: #6b7280;
        font-weight: 500;
      }

      .salespulse-inbox-stage-value {
        display: inline-flex;
        align-items: center;
        padding: 3px 10px;
        border-radius: 12px;
        font-size: 11px;
        font-weight: 600;
        color: white;
        text-transform: uppercase;
        letter-spacing: 0.3px;
        text-shadow: 0 1px 1px rgba(0, 0, 0, 0.2);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
      }

      /* Widget button styles */
      .salespulse-widget-btn-container {
        display: inline-flex;
        align-items: center;
        margin-right: 8px;
      }

      .salespulse-widget-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 12px;
        background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
        color: white;
        border: none;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease;
        font-family: inherit;
        text-decoration: none;
      }

      .salespulse-widget-btn:hover:not(:disabled) {
        opacity: 0.9;
        transform: translateY(-1px);
        box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
      }

      .salespulse-widget-btn:disabled {
        opacity: 0.7;
        cursor: not-allowed;
      }

      .salespulse-widget-btn.salespulse-edit-btn {
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      }

      .salespulse-widget-btn.salespulse-edit-btn:hover:not(:disabled) {
        box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);
      }

      /* Owner button - shows when lead belongs to another sales agent */
      .salespulse-widget-btn.salespulse-owner-btn {
        background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
        cursor: default;
        opacity: 0.9;
      }

      .salespulse-widget-btn.salespulse-owner-btn:hover {
        transform: none;
        box-shadow: none;
      }

      .salespulse-widget-btn.salespulse-loading-btn {
        background: #9ca3af;
      }

      .salespulse-widget-btn .salespulse-btn-spinner {
        width: 12px;
        height: 12px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: sp-spin 0.8s linear infinite;
      }

      .salespulse-btn-spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: sp-spin 0.8s linear infinite;
      }

      /* Stage Badge */
      .salespulse-stage-badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 10px;
        font-weight: 600;
        color: white;
        text-transform: uppercase;
        letter-spacing: 0.3px;
        margin-left: 6px;
        white-space: nowrap;
        text-shadow: 0 1px 1px rgba(0, 0, 0, 0.2);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
      }

      /* Modal Overlay */
      .salespulse-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 999999;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: sp-fadeIn 0.2s ease;
      }

      @keyframes sp-fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      /* Modal Container */
      .salespulse-modal {
        background: white;
        border-radius: 12px;
        width: 420px;
        max-width: 95vw;
        max-height: 90vh;
        overflow: hidden;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        animation: sp-slideIn 0.3s ease;
      }

      @keyframes sp-slideIn {
        from {
          opacity: 0;
          transform: translateY(-20px) scale(0.95);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      /* Modal Header */
      .salespulse-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
        color: white;
      }

      .salespulse-modal-header.edit-mode {
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      }

      .salespulse-modal-header h2 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 8px;
        color: white;
      }

      .salespulse-modal-close {
        background: rgba(255, 255, 255, 0.2);
        border: none;
        border-radius: 6px;
        padding: 6px;
        color: white;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
      }

      .salespulse-modal-close:hover {
        background: rgba(255, 255, 255, 0.3);
      }

      /* Modal Body */
      .salespulse-modal-body {
        padding: 20px;
        max-height: 60vh;
        overflow-y: auto;
      }

      /* Form Styles */
      .salespulse-form-group {
        margin-bottom: 16px;
      }

      .salespulse-form-group label {
        display: block;
        font-size: 13px;
        font-weight: 500;
        color: #374151;
        margin-bottom: 6px;
      }

      .salespulse-form-group label .required {
        color: #ef4444;
      }

      .salespulse-form-input,
      .salespulse-form-select,
      .salespulse-form-textarea {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        font-size: 14px;
        color: #1f2937;
        background: #fff;
        transition: border-color 0.2s, box-shadow 0.2s;
        box-sizing: border-box;
      }

      .salespulse-form-input:focus,
      .salespulse-form-select:focus,
      .salespulse-form-textarea:focus {
        outline: none;
        border-color: #6366f1;
        box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
      }

      .salespulse-form-input:read-only {
        background: #f9fafb;
        color: #6b7280;
      }

      .salespulse-form-textarea {
        resize: vertical;
        min-height: 80px;
      }

      .salespulse-form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }

      .salespulse-input-prefix {
        display: flex;
        align-items: center;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        overflow: hidden;
      }

      .salespulse-input-prefix .prefix {
        padding: 10px 12px;
        background: #f9fafb;
        color: #6b7280;
        border-right: 1px solid #e5e7eb;
        font-size: 14px;
      }

      .salespulse-input-prefix input {
        border: none;
        border-radius: 0;
        flex: 1;
      }

      .salespulse-input-prefix input:focus {
        box-shadow: none;
      }

      /* Detected Badge */
      .salespulse-detected-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: #d1fae5;
        color: #065f46;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 500;
        margin-bottom: 16px;
      }

      /* Edit Mode Badge */
      .salespulse-edit-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: #dbeafe;
        color: #1e40af;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 500;
        margin-bottom: 16px;
      }

      /* Updated At Badge */
      .salespulse-updated-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: #fef3c7;
        color: #92400e;
        border-radius: 20px;
        font-size: 11px;
        font-weight: 500;
        margin-bottom: 16px;
      }

      /* Loading Profile Badge */
      .salespulse-loading-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: #dbeafe;
        color: #1e40af;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 500;
        margin-bottom: 16px;
        margin-left: 8px;
      }

      .salespulse-loading-badge .sp-mini-spinner {
        width: 12px;
        height: 12px;
        border: 2px solid rgba(30, 64, 175, 0.3);
        border-top-color: #1e40af;
        border-radius: 50%;
        animation: sp-spin 0.8s linear infinite;
      }

      /* Modal Footer */
      .salespulse-modal-footer {
        display: flex;
        justify-content: flex-end;
        gap: 12px;
        padding: 16px 20px;
        border-top: 1px solid #e5e7eb;
        background: #f9fafb;
      }

      .salespulse-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 10px 20px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
        border: none;
      }

      .salespulse-btn-primary {
        background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
        color: white;
      }

      .salespulse-btn-primary.edit-mode {
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      }

      .salespulse-btn-primary:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
      }

      .salespulse-btn-primary.edit-mode:hover {
        box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
      }

      .salespulse-btn-primary:disabled {
        opacity: 0.6;
        cursor: not-allowed;
        transform: none;
      }

      .salespulse-btn-secondary {
        background: white;
        color: #374151;
        border: 1px solid #e5e7eb;
      }

      .salespulse-btn-secondary:hover {
        background: #f9fafb;
        border-color: #d1d5db;
      }

      /* Status Messages */
      .salespulse-status {
        padding: 12px 16px;
        border-radius: 8px;
        font-size: 13px;
        margin-bottom: 16px;
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .salespulse-status.success {
        background: #d1fae5;
        color: #065f46;
        border: 1px solid #6ee7b7;
      }

      .salespulse-status.error {
        background: #fee2e2;
        color: #991b1b;
        border: 1px solid #fca5a5;
      }

      .salespulse-status.warning {
        background: #fef3c7;
        color: #92400e;
        border: 1px solid #fcd34d;
      }

      /* Loading Spinner */
      .salespulse-spinner {
        width: 20px;
        height: 20px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: sp-spin 0.8s linear infinite;
      }

      @keyframes sp-spin {
        to { transform: rotate(360deg); }
      }

      /* Success View */
      .salespulse-success-view {
        text-align: center;
        padding: 30px 20px;
      }

      .salespulse-success-view svg {
        width: 64px;
        height: 64px;
        color: #10b981;
        margin-bottom: 16px;
      }

      .salespulse-success-view h3 {
        margin: 0 0 8px;
        font-size: 18px;
        color: #1f2937;
      }

      .salespulse-success-view p {
        margin: 0;
        color: #6b7280;
        font-size: 14px;
      }

      /* Section Divider */
      .salespulse-section-title {
        font-size: 12px;
        font-weight: 600;
        color: #6b7280;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin: 20px 0 12px;
        padding-top: 16px;
        border-top: 1px solid #e5e7eb;
      }

      /* Message List Badges */
      .salespulse-list-badge-container {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        margin-top: 2px;
      }

      .salespulse-list-stage-badge {
        display: inline-flex;
        align-items: center;
        padding: 1px 5px;
        border-radius: 6px;
        font-size: 8px;
        font-weight: 600;
        color: white;
        text-transform: uppercase;
        letter-spacing: 0.2px;
        white-space: nowrap;
        text-shadow: 0 1px 1px rgba(0, 0, 0, 0.2);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
        max-width: 75px;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.2;
      }

      .salespulse-list-owner-badge {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 1px 5px;
        border-radius: 6px;
        font-size: 8px;
        font-weight: 500;
        background: #e5e7eb;
        color: #374151;
        white-space: nowrap;
        max-width: 75px;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.2;
      }

      .salespulse-list-owner-badge svg {
        flex-shrink: 0;
        width: 8px;
        height: 8px;
      }

      .salespulse-list-fresh-badge {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 1px 5px;
        border-radius: 6px;
        font-size: 8px;
        font-weight: 600;
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
        color: white;
        text-transform: uppercase;
        letter-spacing: 0.2px;
        white-space: nowrap;
        text-shadow: 0 1px 1px rgba(0, 0, 0, 0.15);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
        line-height: 1.2;
      }

      .salespulse-list-fresh-badge svg {
        flex-shrink: 0;
        width: 8px;
        height: 8px;
      }

      .salespulse-list-loading-badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 6px;
        border-radius: 8px;
        font-size: 9px;
        font-weight: 500;
        background: #e5e7eb;
        color: #6b7280;
      }

      .salespulse-list-loading-badge .sp-list-spinner {
        width: 8px;
        height: 8px;
        border: 1.5px solid rgba(107, 114, 128, 0.3);
        border-top-color: #6b7280;
        border-radius: 50%;
        animation: sp-spin 0.8s linear infinite;
      }

      /* Ensure badges don't break layout */
      .ThreadDetailsRow .Container.Subtitle {
        flex-wrap: wrap;
      }
    `;

    document.head.appendChild(styles);
  }

  extractPageData() {
    const data = {
      customerName: '',
      freelancerUsername: '',
      projectTitle: '',
      chatUrl: window.location.href,
      projectUrl: '',
      country: '',
      joinedDate: ''
    };

    // Find the right sidebar
    const rightSidebar = document.querySelector('app-messaging-chat-details-redesign');

    if (rightSidebar) {
      // Extract customer name from the sidebar
      const nameElement = rightSidebar.querySelector('.NameContainer .font-bold, .ChatMembers-title .font-bold');
      if (nameElement) {
        let name = '';
        for (const node of nameElement.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            name += node.textContent.trim();
          }
        }
        data.customerName = name.trim();
      }

      // Extract username from the sidebar link
      const usernameLink = rightSidebar.querySelector('a[href*="/u/"]');
      if (usernameLink) {
        const href = usernameLink.getAttribute('href');
        const match = href.match(/\/u\/([^\/\?\&]+)/);
        if (match) {
          data.freelancerUsername = match[1];
        }
      }

      // Extract project title and URL from sidebar
      const projectLink = rightSidebar.querySelector('.ChatContext a[href*="/projects/"]');
      if (projectLink) {
        data.projectTitle = projectLink.textContent.trim();
        data.projectUrl = projectLink.href;
      }
    }

    // Fallback: Try to extract from old header structure if sidebar data is incomplete
    if (!data.customerName) {
      const displayName = document.querySelector('.Username-displayName');
      if (displayName) {
        data.customerName = displayName.textContent.trim();
      }
    }

    if (!data.freelancerUsername) {
      const usernameLink = document.querySelector('fl-username a[href*="/u/"]');
      if (usernameLink) {
        const href = usernameLink.getAttribute('href');
        const match = href.match(/\/u\/([^\/\?\&]+)/);
        if (match) {
          data.freelancerUsername = match[1];
        }
      }
    }

    // If no customer name but have username, use username as name
    if (!data.customerName && data.freelancerUsername) {
      data.customerName = data.freelancerUsername;
    }

    return data;
  }

  async fetchProfileData(username) {
    if (!username) return null;

    // Check cache first
    if (this.profileDataCache[username]) {
      console.log('SalesPulse: Using cached profile data for', username);
      return this.profileDataCache[username];
    }

    const profileData = {
      country: '',
      joinedDate: '',
      joinedDateISO: '',
      avatarUrl: ''
    };

    // Country code to name mapping
    const countryNames = {
      'AF': 'Afghanistan', 'AL': 'Albania', 'DZ': 'Algeria', 'AR': 'Argentina', 'AU': 'Australia',
      'AT': 'Austria', 'BD': 'Bangladesh', 'BE': 'Belgium', 'BR': 'Brazil', 'BG': 'Bulgaria',
      'CA': 'Canada', 'CL': 'Chile', 'CN': 'China', 'CO': 'Colombia', 'HR': 'Croatia',
      'CZ': 'Czech Republic', 'DK': 'Denmark', 'EG': 'Egypt', 'FI': 'Finland', 'FR': 'France',
      'DE': 'Germany', 'GR': 'Greece', 'HK': 'Hong Kong', 'HU': 'Hungary', 'IN': 'India',
      'ID': 'Indonesia', 'IE': 'Ireland', 'IL': 'Israel', 'IT': 'Italy', 'JP': 'Japan',
      'KE': 'Kenya', 'MY': 'Malaysia', 'MX': 'Mexico', 'NL': 'Netherlands', 'NZ': 'New Zealand',
      'NG': 'Nigeria', 'NO': 'Norway', 'PK': 'Pakistan', 'PE': 'Peru', 'PH': 'Philippines',
      'PL': 'Poland', 'PT': 'Portugal', 'RO': 'Romania', 'RU': 'Russia', 'SA': 'Saudi Arabia',
      'SG': 'Singapore', 'ZA': 'South Africa', 'KR': 'South Korea', 'ES': 'Spain', 'SE': 'Sweden',
      'CH': 'Switzerland', 'TW': 'Taiwan', 'TH': 'Thailand', 'TR': 'Turkey', 'UA': 'Ukraine',
      'AE': 'United Arab Emirates', 'GB': 'United Kingdom', 'US': 'United States', 'VN': 'Vietnam'
    };

    try {
      // Method 1: Try Freelancer's internal API
      console.log('SalesPulse: Fetching profile via API for', username);
      // Note: avatar=true is needed to get avatar data, compact=true may exclude it
      const apiUrl = `https://www.freelancer.com/api/users/0.1/users?usernames[]=${encodeURIComponent(username)}&avatar=true`;

      const response = await fetch(apiUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        console.log('SalesPulse: API response:', data);

        if (data.status === 'success' && data.result && data.result.users) {
          const users = Object.values(data.result.users);
          if (users.length > 0) {
            const user = users[0];

            // Get country from location
            if (user.location && user.location.country) {
              const countryCode = user.location.country.code;
              profileData.country = countryNames[countryCode] || user.location.country.name || countryCode;
              console.log('SalesPulse: Found country via API:', profileData.country);
            }

            // Get registration date
            if (user.registration_date) {
              const regDate = new Date(user.registration_date * 1000);
              if (!isNaN(regDate.getTime())) {
                profileData.joinedDate = regDate.toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric'
                });
                profileData.joinedDateISO = regDate.toISOString().split('T')[0];
                console.log('SalesPulse: Found joined date via API:', profileData.joinedDate);
              }
            }

            // Get avatar URL - try different fields that Freelancer API might use
            // Log full user object for debugging
            console.log('SalesPulse: Full user object:', JSON.stringify(user, null, 2));

            if (user.avatar_large_cdn) {
              profileData.avatarUrl = user.avatar_large_cdn;
              console.log('SalesPulse: Found avatar via API (avatar_large_cdn):', profileData.avatarUrl);
            } else if (user.avatar_cdn) {
              profileData.avatarUrl = user.avatar_cdn;
              console.log('SalesPulse: Found avatar via API (avatar_cdn):', profileData.avatarUrl);
            } else if (user.avatar_large) {
              profileData.avatarUrl = user.avatar_large;
              console.log('SalesPulse: Found avatar via API (avatar_large):', profileData.avatarUrl);
            } else if (user.avatar) {
              profileData.avatarUrl = user.avatar;
              console.log('SalesPulse: Found avatar via API (avatar):', profileData.avatarUrl);
            } else if (user.profile_logo_url) {
              profileData.avatarUrl = user.profile_logo_url;
              console.log('SalesPulse: Found avatar via API (profile_logo_url):', profileData.avatarUrl);
            } else {
              console.log('SalesPulse: No avatar field found in user object');
            }

            // Normalize avatar URL - add https: if it's a protocol-relative URL
            if (profileData.avatarUrl && profileData.avatarUrl.startsWith('//')) {
              profileData.avatarUrl = 'https:' + profileData.avatarUrl;
              console.log('SalesPulse: Normalized avatar URL to:', profileData.avatarUrl);
            }
          }
        }
      } else {
        console.log('SalesPulse: API request failed with status:', response.status);
      }
    } catch (error) {
      console.error('SalesPulse: Error fetching from API:', error);
    }

    // Method 2: Fallback to scraping profile page HTML if API didn't work or missing data
    if (!profileData.country || !profileData.joinedDate || !profileData.avatarUrl) {
      console.log('SalesPulse: Trying HTML scraping fallback for missing data');
      try {
        const profileUrl = `https://www.freelancer.com/u/${username}`;
        const response = await fetch(profileUrl, {
          method: 'GET',
          credentials: 'include'
        });

        if (response.ok) {
          const html = await response.text();

          // Try to find country from flag image URL
          if (!profileData.country) {
            const flagMatch = html.match(/\/flags\/([a-z]{2})\.png/i);
            if (flagMatch) {
              const code = flagMatch[1].toUpperCase();
              profileData.country = countryNames[code] || code;
              console.log('SalesPulse: Found country from HTML:', profileData.country);
            }
          }

          // Try to find joined date
          if (!profileData.joinedDate) {
            const joinedMatch = html.match(/Joined\s+(?:on\s+)?([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
            if (joinedMatch) {
              profileData.joinedDate = joinedMatch[1].trim();
              try {
                const dateObj = new Date(profileData.joinedDate);
                if (!isNaN(dateObj.getTime())) {
                  profileData.joinedDateISO = dateObj.toISOString().split('T')[0];
                }
              } catch (e) {}
              console.log('SalesPulse: Found joined date from HTML:', profileData.joinedDate);
            }
          }

          // Try to find avatar/profile picture from HTML
          if (!profileData.avatarUrl) {
            // Look for profile image in various common patterns
            const avatarPatterns = [
              // cdn.freelancer.com avatar URLs
              /https:\/\/cdn\d*\.freelancer\.com\/[^"'\s]+(?:avatar|profile)[^"'\s]*\.(?:jpg|jpeg|png|gif|webp)/i,
              // Profile image in img tag with class
              /<img[^>]+class="[^"]*(?:profile|avatar|user)[^"]*"[^>]+src="([^"]+)"/i,
              // Profile image src pattern
              /(?:profile|avatar|user)(?:_|-)?(?:image|img|pic|photo)[^"']*["']\s*:\s*["']([^"']+)/i,
              // Any cdn.freelancer.com image URL that looks like a profile pic
              /(https:\/\/cdn\d*\.freelancer\.com\/u\/\d+\/[^"'\s]+\.(?:jpg|jpeg|png|gif|webp))/i
            ];

            for (const pattern of avatarPatterns) {
              const match = html.match(pattern);
              if (match) {
                profileData.avatarUrl = match[1] || match[0];
                // Clean up the URL if needed
                if (profileData.avatarUrl && !profileData.avatarUrl.startsWith('http')) {
                  profileData.avatarUrl = 'https://www.freelancer.com' + profileData.avatarUrl;
                }
                console.log('SalesPulse: Found avatar from HTML:', profileData.avatarUrl);
                break;
              }
            }
          }
        }
      } catch (error) {
        console.error('SalesPulse: Error scraping profile:', error);
      }
    }

    console.log('SalesPulse: Final profile data:', profileData);

    // Cache the result if we found anything
    if (profileData.country || profileData.joinedDate || profileData.avatarUrl) {
      this.profileDataCache[username] = profileData;
    }

    return profileData;
  }

  async loadStages() {
    if (!this.baseUrl || !this.apiToken) return;

    try {
      const response = await fetch(`${this.getApiUrl()}/stages`, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        this.stages = data.stages || [];
      }
    } catch (error) {
      console.error('SalesPulse: Failed to load stages', error);
    }
  }

  async loadCurrencies() {
    if (!this.baseUrl || !this.apiToken) return;

    try {
      const response = await fetch(`${this.getApiUrl()}/currencies`, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        this.currencies = data.currencies || [];
        this.baseCurrency = data.base_currency || 'USD';
      }
    } catch (error) {
      console.error('SalesPulse: Failed to load currencies', error);
    }
  }

  async showModal() {
    // Remove existing modal (don't click back button - we're preparing to show a new modal)
    this.hideModal(false);

    // Reset widget mode (this is called from inbox context)
    this.isWidgetMode = false;
    this.widgetData = null;

    // Check if context was invalidated
    if (this.contextInvalidated) {
      this.showRefreshMessage();
      return;
    }

    // Load settings first
    await this.loadSettings();
    if (this.contextInvalidated) {
      this.showRefreshMessage();
      return;
    }

    // If in edit mode, fetch fresh data from API
    if (this.isEditMode && this.existingLead) {
      console.log('SalesPulse: Fetching fresh lead data for inbox');
      await this.fetchFreshInboxLeadData();
    }

    // Load stages, currencies and render modal
    await this.loadStages();
    await this.loadCurrencies();
    this.renderModal();
  }

  // Fetch fresh lead data for inbox mode
  async fetchFreshInboxLeadData() {
    if (!this.currentChatUrl) return;

    try {
      const response = await fetch(`${this.getApiUrl()}/leads/check?chat_url=${encodeURIComponent(this.currentChatUrl)}`, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.exists && data.lead) {
          this.existingLead = {
            id: data.lead.id,
            title: data.lead.title,
            amount: data.lead.amount,
            currency: data.lead.currency || 'USD',
            description: data.lead.description,
            freelancer_chat_url: data.lead.freelancer_chat_url,
            project_url: data.lead.project_url,
            lead_stage_id: data.lead.lead_stage_id,
            stage: data.lead.stage,
            updated_at: data.lead.updated_at,
            customer: data.lead.customer
          };
          this.isEditMode = true;

          // Update button and stage badge
          this.updateButtonState();

          console.log('SalesPulse: Fetched fresh inbox lead data:', this.existingLead);
          return;
        }
      }
    } catch (error) {
      console.error('SalesPulse: Error fetching fresh inbox lead data:', error);
    }
    // Keep existing data if fetch fails
  }

  showRefreshMessage() {
    const overlay = document.createElement('div');
    overlay.id = 'salespulse-modal-overlay';
    overlay.className = 'salespulse-modal-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const modal = document.createElement('div');
    modal.className = 'salespulse-modal';
    modal.innerHTML = `
      <div class="salespulse-modal-header">
        <h2>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
          Page Refresh Required
        </h2>
        <button class="salespulse-modal-close" onclick="this.closest('.salespulse-modal-overlay').remove()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <div class="salespulse-modal-body">
        <div class="salespulse-status warning">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 8v4m0 4h.01"/>
          </svg>
          <span>The extension was updated. Please refresh this page to continue.</span>
        </div>
      </div>
      <div class="salespulse-modal-footer">
        <button class="salespulse-btn salespulse-btn-primary" onclick="location.reload()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
          Refresh Page
        </button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  renderModal() {
    // Use widget data if in widget mode, otherwise extract from page
    const pageData = this.isWidgetMode && this.widgetData ? this.widgetData : this.extractPageData();

    console.log('SalesPulse: renderModal - isWidgetMode:', this.isWidgetMode, 'hasWidgetData:', !!this.widgetData);
    console.log('SalesPulse: renderModal - pageData:', pageData);

    // If in edit mode, use existing lead data
    let formData = pageData;
    if (this.isEditMode && this.existingLead) {
      formData = {
        leadId: this.existingLead.id || '',
        customerName: this.existingLead.customer?.name || pageData.customerName,
        freelancerUsername: this.existingLead.customer?.freelancer_username || pageData.freelancerUsername,
        projectTitle: this.existingLead.title || pageData.projectTitle,
        chatUrl: this.existingLead.freelancer_chat_url || pageData.chatUrl,
        projectUrl: this.existingLead.project_url || pageData.projectUrl,
        country: this.existingLead.customer?.country || '',
        joinedDate: this.existingLead.customer?.freelancer_join_date || '',
        avatarUrl: this.existingLead.customer?.avatar_url || '',
        amount: this.existingLead.amount || '',
        currency: this.existingLead.currency || 'USD',
        stageId: this.existingLead.lead_stage_id || '',
        description: this.existingLead.description || '',
        updatedAt: this.existingLead.updated_at || ''
      };
    }

    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = 'salespulse-modal-overlay';
    overlay.className = 'salespulse-modal-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.hideModal();
    });

    const modalTitle = this.isEditMode ? 'Edit Lead' : 'Save Lead';
    const headerClass = this.isEditMode ? 'salespulse-modal-header edit-mode' : 'salespulse-modal-header';
    const submitBtnClass = this.isEditMode ? 'salespulse-btn salespulse-btn-primary edit-mode' : 'salespulse-btn salespulse-btn-primary';
    const submitBtnText = this.isEditMode ? 'Update Lead' : 'Save Lead';
    const headerIcon = this.isEditMode
      ? '<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>'
      : '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>';

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'salespulse-modal';
    modal.innerHTML = `
      <div class="${headerClass}">
        <h2>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            ${headerIcon}
          </svg>
          ${modalTitle}
        </h2>
        <button class="salespulse-modal-close" id="salespulse-close-btn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="salespulse-modal-body">
        <div id="salespulse-form-view">
          ${!this.apiToken ? `
            <div class="salespulse-status warning">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 8v4m0 4h.01"/>
              </svg>
              <span>Please configure your API settings in the extension popup first.</span>
            </div>
          ` : ''}

          <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">
            ${this.isEditMode ? `
              <div class="salespulse-edit-badge">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                Editing Lead #${formData.leadId || ''}
              </div>
              ${formData.updatedAt ? `
              <div class="salespulse-updated-badge">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 6v6l4 2"/>
                </svg>
                Updated: ${this.formatDateTime(formData.updatedAt)}
              </div>
              ` : ''}
            ` : formData.customerName ? `
              <div class="salespulse-detected-badge">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
                  <path d="M22 4L12 14.01l-3-3"/>
                </svg>
                Auto-detected from chat
              </div>
            ` : ''}
            <div id="sp-profile-loading" class="salespulse-loading-badge" style="display: none;">
              <div class="sp-mini-spinner"></div>
              Loading profile...
            </div>
          </div>

          <div id="salespulse-error-msg" class="salespulse-status error" style="display: none;"></div>

          <div class="salespulse-form-group">
            <label>Customer Name <span class="required">*</span></label>
            <input type="text" class="salespulse-form-input" id="sp-customer-name"
                   value="${this.escapeHtml(formData.customerName)}" placeholder="Customer name">
          </div>

          <div class="salespulse-form-group">
            <label>Freelancer Username</label>
            <div class="salespulse-input-prefix">
              <span class="prefix">@</span>
              <input type="text" class="salespulse-form-input" id="sp-username"
                     value="${this.escapeHtml(formData.freelancerUsername)}" placeholder="username">
            </div>
          </div>

          <div class="salespulse-form-row">
            <div class="salespulse-form-group">
              <label>Country</label>
              <input type="text" class="salespulse-form-input" id="sp-country"
                     value="${this.escapeHtml(formData.country || '')}" placeholder="${this.isEditMode ? 'Not set' : 'Loading...'}" ${this.isEditMode && formData.country ? '' : 'readonly'}>
            </div>
            <div class="salespulse-form-group">
              <label>Member Since</label>
              <input type="text" class="salespulse-form-input" id="sp-joined-date"
                     value="${this.escapeHtml(this.formatDate(formData.joinedDate) || '')}" placeholder="${this.isEditMode ? 'Not set' : 'Loading...'}" readonly>
            </div>
          </div>
          <!-- Hidden input for avatar URL -->
          <input type="hidden" id="sp-avatar-url" value="${this.escapeHtml(formData.avatarUrl || '')}">

          <div class="salespulse-section-title">Lead Information</div>

          <div class="salespulse-form-row">
            <div class="salespulse-form-group">
              <label>Lead Title</label>
              <input type="text" class="salespulse-form-input" id="sp-lead-title"
                     value="${this.escapeHtml(formData.projectTitle)}" placeholder="e.g., Website Project">
            </div>
            <div class="salespulse-form-group">
              <label>Amount</label>
              <div style="display: flex; gap: 8px;">
                <input type="number" class="salespulse-form-input" id="sp-amount" style="flex: 1;"
                       value="${formData.amount || ''}" placeholder="0.00" step="0.01" min="0">
                <select class="salespulse-form-select" id="sp-currency" style="width: 90px;">
                  ${this.currencies.length > 0
                    ? this.currencies.map(c => `<option value="${c.code}" ${(formData.currency || 'USD') === c.code ? 'selected' : ''}>${c.code}</option>`).join('')
                    : '<option value="USD" selected>USD</option>'}
                </select>
              </div>
            </div>
          </div>

          <div class="salespulse-form-group">
            <label>Stage</label>
            <select class="salespulse-form-select" id="sp-stage">
              ${this.stages.length > 0
                ? this.stages.map(s => `<option value="${s.id}" ${formData.stageId == s.id ? 'selected' : ''}>${this.escapeHtml(s.name)}</option>`).join('')
                : '<option value="">Loading stages...</option>'}
            </select>
          </div>

          <div class="salespulse-form-group">
            <label>Chat URL</label>
            <input type="url" class="salespulse-form-input" id="sp-chat-url"
                   value="${this.escapeHtml(formData.chatUrl)}" placeholder="https://freelancer.com/messages/thread/...">
          </div>

          <div class="salespulse-form-group">
            <label>Project URL</label>
            <input type="url" class="salespulse-form-input" id="sp-project-url"
                   value="${this.escapeHtml(formData.projectUrl)}" placeholder="https://freelancer.com/projects/...">
          </div>

          <div class="salespulse-form-group">
            <label>Notes</label>
            <textarea class="salespulse-form-textarea" id="sp-notes"
                      placeholder="Any additional notes...">${this.escapeHtml(formData.description || '')}</textarea>
          </div>
        </div>

        <div id="salespulse-success-view" class="salespulse-success-view" style="display: none;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
          <h3>${this.isEditMode ? 'Lead Updated!' : 'Lead Saved!'}</h3>
          <p id="sp-success-msg">Lead has been ${this.isEditMode ? 'updated in' : 'added to'} your CRM</p>
        </div>
      </div>

      <div class="salespulse-modal-footer" id="salespulse-footer-buttons">
        <button class="salespulse-btn salespulse-btn-secondary" id="salespulse-cancel-btn">Cancel</button>
        <button class="${submitBtnClass}" id="salespulse-save-btn" ${!this.apiToken ? 'disabled' : ''}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            ${this.isEditMode
              ? '<path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>'
              : '<path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>'}
          </svg>
          ${submitBtnText}
        </button>
      </div>

      <div class="salespulse-modal-footer" id="salespulse-footer-done" style="display: none;">
        <button class="salespulse-btn salespulse-btn-secondary" id="salespulse-another-btn">${this.isEditMode ? 'Edit Again' : 'Save Another'}</button>
        <button class="salespulse-btn salespulse-btn-primary" id="salespulse-done-btn">Done</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Bind events
    document.getElementById('salespulse-close-btn').addEventListener('click', () => this.hideModal());
    document.getElementById('salespulse-cancel-btn').addEventListener('click', () => this.hideModal());
    document.getElementById('salespulse-save-btn').addEventListener('click', () => this.saveLead());
    document.getElementById('salespulse-done-btn').addEventListener('click', () => this.hideModal());
    document.getElementById('salespulse-another-btn').addEventListener('click', () => this.resetForm());

    // Close on Escape key
    document.addEventListener('keydown', this.handleEscKey);

    // Fetch profile data in background if not in edit mode or if country is missing
    if (!this.isEditMode || !formData.country) {
      const username = formData.freelancerUsername || pageData.freelancerUsername;
      if (username) {
        this.loadProfileData(username);
      } else {
        // No username, clear the loading placeholders
        document.getElementById('sp-country').value = '';
        document.getElementById('sp-country').placeholder = 'N/A';
        document.getElementById('sp-country').readOnly = false;
        document.getElementById('sp-joined-date').value = '';
        document.getElementById('sp-joined-date').placeholder = 'N/A';
      }
    }
  }

  async loadProfileData(username) {
    const loadingBadge = document.getElementById('sp-profile-loading');
    const countryInput = document.getElementById('sp-country');
    const joinedInput = document.getElementById('sp-joined-date');

    if (loadingBadge) loadingBadge.style.display = 'inline-flex';

    const profileData = await this.fetchProfileData(username);

    if (loadingBadge) loadingBadge.style.display = 'none';

    if (profileData) {
      if (countryInput && !countryInput.value) {
        countryInput.value = profileData.country || '';
        countryInput.placeholder = profileData.country ? '' : 'Not available';
        countryInput.readOnly = false;
      }
      if (joinedInput && !joinedInput.value) {
        joinedInput.value = profileData.joinedDate || '';
        joinedInput.placeholder = profileData.joinedDate ? '' : 'Not available';
        // Store ISO date for API
        if (profileData.joinedDateISO) {
          joinedInput.dataset.isoDate = profileData.joinedDateISO;
        }
      }
      // Set avatar URL if found
      const avatarInput = document.getElementById('sp-avatar-url');
      if (avatarInput && profileData.avatarUrl) {
        avatarInput.value = profileData.avatarUrl;
        console.log('SalesPulse: Set avatar URL in form:', profileData.avatarUrl);
      }
    } else {
      if (countryInput && !countryInput.value) {
        countryInput.value = '';
        countryInput.placeholder = 'Could not load';
        countryInput.readOnly = false;
      }
      if (joinedInput && !joinedInput.value) {
        joinedInput.value = '';
        joinedInput.placeholder = 'Could not load';
      }
    }
  }

  handleEscKey = (e) => {
    if (e.key === 'Escape') {
      this.hideModal();
    }
  }

  hideModal(clickBackButton = true) {
    const overlay = document.getElementById('salespulse-modal-overlay');
    if (overlay) {
      overlay.remove();
    }
    document.removeEventListener('keydown', this.handleEscKey);

    // If we opened the details panel to extract chat URL, click back to return to chat
    // Only do this when explicitly closing the modal (not when hiding to show a new one)
    if (clickBackButton) {
      this.clickBackButtonToReturnToChat();
    }
  }

  showError(message) {
    const errorEl = document.getElementById('salespulse-error-msg');
    if (errorEl) {
      errorEl.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 8v4m0 4h.01"/>
        </svg>
        <span>${this.escapeHtml(message)}</span>
      `;
      errorEl.style.display = 'flex';
    }
  }

  hideError() {
    const errorEl = document.getElementById('salespulse-error-msg');
    if (errorEl) {
      errorEl.style.display = 'none';
    }
  }

  async saveLead() {
    const saveBtn = document.getElementById('salespulse-save-btn');
    const customerName = document.getElementById('sp-customer-name').value.trim();
    const username = document.getElementById('sp-username').value.trim();
    const country = document.getElementById('sp-country').value.trim();
    const joinedDateInput = document.getElementById('sp-joined-date');
    const joinedDate = joinedDateInput.dataset.isoDate || '';
    const leadTitle = document.getElementById('sp-lead-title').value.trim();
    const amount = document.getElementById('sp-amount').value;
    const currency = document.getElementById('sp-currency').value;
    const stageId = document.getElementById('sp-stage').value;
    const chatUrl = document.getElementById('sp-chat-url').value.trim();
    const projectUrl = document.getElementById('sp-project-url').value.trim();
    const notes = document.getElementById('sp-notes').value.trim();
    const avatarUrl = document.getElementById('sp-avatar-url')?.value || '';

    if (!customerName) {
      this.showError('Customer name is required');
      return;
    }

    this.hideError();

    // Show loading state
    saveBtn.disabled = true;
    const originalBtnText = saveBtn.innerHTML;
    saveBtn.innerHTML = `<div class="salespulse-spinner"></div> ${this.isEditMode ? 'Updating...' : 'Saving...'}`;

    try {
      const payload = {
        customer_name: customerName,
        freelancer_username: username || null,
        freelancer_profile_url: username ? `https://www.freelancer.com/u/${username}` : null,
        avatar_url: avatarUrl || null,
        country: country || null,
        freelancer_join_date: joinedDate || null,
        lead_title: leadTitle || null,
        lead_amount: amount ? parseFloat(amount) : null,
        lead_currency: currency || 'USD',
        lead_stage_id: stageId ? parseInt(stageId) : null,
        freelancer_chat_url: chatUrl || null,
        project_url: projectUrl || null,
        description: notes || null
      };

      let url = `${this.getApiUrl()}/leads`;
      let method = 'POST';

      // If editing, use PUT and include lead ID in URL
      if (this.isEditMode && this.existingLead) {
        url = `${this.getApiUrl()}/leads/${this.existingLead.id}`;
        method = 'PUT';
      }

      const response = await fetch(url, {
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${this.apiToken}`
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || data.error || `Failed to ${this.isEditMode ? 'update' : 'save'} lead`);
      }

      // Update existing lead data
      if (data.lead) {
        this.existingLead = {
          id: data.lead.id,
          title: data.lead.title,
          amount: data.lead.amount,
          currency: data.lead.currency || 'USD',
          description: data.lead.description,
          freelancer_chat_url: data.lead.freelancer_chat_url,
          project_url: data.lead.project_url,
          lead_stage_id: data.lead.lead_stage_id,
          stage: data.lead.stage,
          customer: data.customer
        };

        const wasEditMode = this.isEditMode;
        this.isEditMode = true;

        // Update the appropriate button based on mode (for both create and update)
        if (this.isWidgetMode && this.currentUsername) {
          this.updateWidgetButtonAfterSave(this.currentUsername, data.lead, data.customer);
        } else {
          this.updateButtonState();
        }

        // Refresh list badges to show the new/updated lead
        this.refreshListBadges();
      }

      // Show success
      this.showSuccess(leadTitle || 'Lead', customerName);
    } catch (error) {
      this.showError(error.message);
      saveBtn.disabled = false;
      saveBtn.innerHTML = originalBtnText;
    }
  }

  showSuccess(leadTitle, customerName) {
    document.getElementById('salespulse-form-view').style.display = 'none';
    document.getElementById('salespulse-success-view').style.display = 'block';
    document.getElementById('salespulse-footer-buttons').style.display = 'none';
    document.getElementById('salespulse-footer-done').style.display = 'flex';

    const action = this.isEditMode ? 'updated in' : 'added to';
    document.getElementById('sp-success-msg').textContent =
      `Lead "${leadTitle}" for ${customerName} has been ${action} your CRM`;
  }

  resetForm() {
    // Re-render the modal with current state (don't click back button - just resetting form)
    this.hideModal(false);
    this.showModal();
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new SalesPulseInjector());
} else {
  new SalesPulseInjector();
}
