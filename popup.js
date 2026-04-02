// UTRehome - Popup Script

document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

// Get current view from background
chrome.runtime.sendMessage({ type: 'getDefaultView' }, (response) => {
  const view = response?.defaultView || 'subscriptions';
  document.getElementById('current-view').textContent = view;
});

// Refresh button
document.getElementById('refresh-btn').addEventListener('click', () => {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Refreshing…';

  chrome.runtime.sendMessage({ type: 'refreshSubscriptions' }, () => {
    // Brief delay so user sees feedback
    setTimeout(() => window.close(), 300);
  });
});
