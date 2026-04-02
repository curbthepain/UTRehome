// UTRehome v2 - Minimal MV3 Service Worker

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({ defaultView: 'subscriptions' });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getDefaultView') {
    chrome.storage.local.get('defaultView', (result) => {
      sendResponse({ defaultView: result.defaultView || 'subscriptions' });
    });
    return true; // async response
  }
  if (message.type === 'setDefaultView') {
    chrome.storage.local.set({ defaultView: message.view });
  }
});
