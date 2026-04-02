// UTRehome v2 - Content Script
// Replaces YouTube home feed with subscriptions, with toggle support

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────

  const state = {
    currentView: 'subscriptions',
    isHomePage: false,
    config: null,
    configReady: null, // Promise
    cache: { videos: [], sections: [], continuationToken: null, fetchedAt: 0 },
    abortController: null,
    mutationObserver: null,
    scrollObserver: null,
    generation: 0,
    loading: false,
    injectedScript: false,
    gridColumns: 4,
  };

  const CACHE_LIFETIME = 5 * 60 * 1000; // 5 minutes
  const HOME_URL_RE = /^https:\/\/(www|m)\.youtube\.com\/?(\?[^#]*)?(#.*)?$/;

  // ── Config Extraction ──────────────────────────────────────────────────

  function injectConfigScript() {
    if (state.injectedScript) return state.configReady;

    state.configReady = new Promise((resolve) => {
      const handler = (e) => {
        document.removeEventListener('utrehome-config-response', handler);
        try {
          state.config = JSON.parse(e.detail);
          console.log('[UTRehome] Config received:', {
            apiKey: state.config?.apiKey ? 'present' : 'missing',
            context: state.config?.context ? 'present' : 'missing',
            loggedIn: state.config?.loggedIn,
          });
          resolve(state.config);
        } catch (err) {
          console.error('[UTRehome] Config parse error:', err);
          resolve(null);
        }
      };
      document.addEventListener('utrehome-config-response', handler);

      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('injected.js');
      script.onload = () => script.remove();
      script.onerror = (err) => {
        console.error('[UTRehome] Failed to inject script:', err);
        resolve(null);
      };
      document.documentElement.appendChild(script);

      // Timeout fallback
      setTimeout(() => {
        if (!state.config) {
          console.warn('[UTRehome] Config timeout - trying DOM fallback');
          // Fallback: try to extract config from DOM script tags
          tryDOMConfigFallback();
        }
        resolve(state.config);
      }, 6000);
    });

    state.injectedScript = true;
    return state.configReady;
  }

  function tryDOMConfigFallback() {
    // Scan page scripts for ytcfg data as a fallback
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent;
      if (!text) continue;

      // Look for INNERTUBE_API_KEY in script content
      const keyMatch = text.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
      const contextMatch = text.match(/"INNERTUBE_CONTEXT":\s*(\{[^}]+\})/);

      if (keyMatch) {
        console.log('[UTRehome] DOM fallback found API key');
        if (!state.config) state.config = {};
        state.config.apiKey = keyMatch[1];
      }
    }
  }

  // ── Page Detection ─────────────────────────────────────────────────────

  function isHomePage() {
    return HOME_URL_RE.test(window.location.href);
  }

  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  // ── InnerTube API ──────────────────────────────────────────────────────

  async function refreshAuthHeader() {
    // Request a fresh SAPISIDHASH from the page-world script
    return new Promise((resolve) => {
      const handler = (e) => {
        document.removeEventListener('utrehome-config-response', handler);
        try {
          const freshConfig = JSON.parse(e.detail);
          if (freshConfig.authHeader) {
            state.config.authHeader = freshConfig.authHeader;
          }
        } catch { /* ignore */ }
        resolve();
      };
      document.addEventListener('utrehome-config-response', handler);
      document.dispatchEvent(new CustomEvent('utrehome-request-config'));
      setTimeout(resolve, 2000); // Timeout fallback
    });
  }

  async function fetchSubscriptions(continuation = null) {
    if (!state.config) {
      console.error('[UTRehome] No config available for API call');
      return null;
    }

    // Refresh auth header before each fetch (it's time-based)
    await refreshAuthHeader();

    state.abortController = new AbortController();

    const body = {
      context: state.config.context,
    };

    if (continuation) {
      body.continuation = continuation;
    } else {
      body.browseId = 'FEsubscriptions';
    }

    // Build URL - API key may be empty on some YouTube versions
    let url = 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false';
    if (state.config.apiKey) {
      url += `&key=${state.config.apiKey}`;
    }

    console.log('[UTRehome] Fetching subscriptions...', {
      continuation: !!continuation,
      browseId: body.browseId,
      hasAuth: !!state.config.authHeader,
      hasSapisid: !!state.config.sapisid,
    });

    // Build auth headers
    const headers = { 'Content-Type': 'application/json' };

    // Add SAPISIDHASH authorization (required for authenticated API calls)
    if (state.config.authHeader) {
      headers['Authorization'] = state.config.authHeader;
    }

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: state.abortController.signal,
        credentials: 'include',
      });

      if (!resp.ok) {
        console.error('[UTRehome] API response not ok:', resp.status, resp.statusText);
        return null;
      }

      const data = await resp.json();
      console.log('[UTRehome] API response keys:', JSON.stringify(Object.keys(data)));
      if (data.contents) {
        const contentsKeys = Object.keys(data.contents);
        console.log('[UTRehome] contents keys:', JSON.stringify(contentsKeys));
        const tcbr = data.contents.twoColumnBrowseResultsRenderer;
        if (tcbr) {
          console.log('[UTRehome] tabs count:', tcbr.tabs?.length);
          const tab = tcbr.tabs?.[0];
          if (tab) {
            const tabKeys = Object.keys(tab);
            console.log('[UTRehome] tab[0] keys:', JSON.stringify(tabKeys));
            const tabR = tab.tabRenderer;
            if (tabR) {
              const tabRKeys = Object.keys(tabR);
              console.log('[UTRehome] tabRenderer keys:', JSON.stringify(tabRKeys));
              if (tabR.content) {
                const contentKeys = Object.keys(tabR.content);
                console.log('[UTRehome] tabRenderer.content keys:', JSON.stringify(contentKeys));
                // Log whatever renderer is inside
                for (const key of contentKeys) {
                  const renderer = tabR.content[key];
                  if (renderer?.contents) {
                    console.log('[UTRehome]', key, '.contents count:', renderer.contents.length);
                    // Log first 3 items' keys
                    for (let i = 0; i < Math.min(3, renderer.contents.length); i++) {
                      console.log('[UTRehome]', key, '.contents[' + i + '] keys:', JSON.stringify(Object.keys(renderer.contents[i])));
                      // Log content details for any renderer type
                      const rir = renderer.contents[i].richItemRenderer;
                      if (rir?.content) {
                        console.log('[UTRehome]   richItemRenderer.content keys:', JSON.stringify(Object.keys(rir.content)));
                      }
                      // If itemSectionRenderer, log its inner contents
                      const isr = renderer.contents[i].itemSectionRenderer;
                      if (isr?.contents) {
                        console.log('[UTRehome]   itemSectionRenderer.contents count:', isr.contents.length);
                        for (let j = 0; j < Math.min(3, isr.contents.length); j++) {
                          const innerKeys = Object.keys(isr.contents[j]);
                          console.log('[UTRehome]   itemSectionRenderer.contents[' + j + '] keys:', JSON.stringify(innerKeys));
                          // One more level for shelfRenderer/gridRenderer
                          for (const ik of innerKeys) {
                            const inner = isr.contents[j][ik];
                            if (inner?.content) {
                              console.log('[UTRehome]     ' + ik + '.content keys:', JSON.stringify(Object.keys(inner.content)));
                            }
                            if (inner?.contents) {
                              console.log('[UTRehome]     ' + ik + '.contents count:', inner.contents.length);
                              if (inner.contents[0]) {
                                console.log('[UTRehome]     ' + ik + '.contents[0] keys:', JSON.stringify(Object.keys(inner.contents[0])));
                              }
                            }
                            if (inner?.items) {
                              console.log('[UTRehome]     ' + ik + '.items count:', inner.items.length);
                              if (inner.items[0]) {
                                console.log('[UTRehome]     ' + ik + '.items[0] keys:', JSON.stringify(Object.keys(inner.items[0])));
                              }
                            }
                          }
                        }
                      }
                    }
                  } else {
                    console.log('[UTRehome]', key, 'keys:', JSON.stringify(Object.keys(renderer || {})).substring(0, 200));
                  }
                }
              }
            } else {
              console.log('[UTRehome] tab[0] is NOT tabRenderer, keys:', JSON.stringify(tabKeys));
            }
          }
        }
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') return null;
      console.error('[UTRehome] Fetch error:', e);
      return null;
    }
  }

  // ── Response Parsing ───────────────────────────────────────────────────

  function parseVideoFromRenderer(renderer) {
    if (!renderer) return null;

    // Try videoRenderer (legacy format)
    const vr = renderer.videoRenderer;
    if (vr) {
      return {
        videoId: vr.videoId,
        title: vr.title?.runs?.[0]?.text || vr.title?.simpleText || '',
        thumbnail: getBestThumbnail(vr.thumbnail?.thumbnails),
        channelName: vr.ownerText?.runs?.[0]?.text || vr.shortBylineText?.runs?.[0]?.text || '',
        channelUrl: vr.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ||
                    vr.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '',
        channelAvatar: getBestThumbnail(
          vr.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails ||
          vr.channelThumbnail?.thumbnails
        ),
        viewCount: vr.viewCountText?.simpleText || vr.viewCountText?.runs?.map(r => r.text).join('') || '',
        publishedTime: vr.publishedTimeText?.simpleText || '',
        duration: vr.lengthText?.simpleText || '',
        isLive: vr.badges?.some(b => b.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW') || false,
      };
    }

    // Try lockupViewModel (newer format)
    const lvm = renderer.lockupViewModel;
    if (lvm) {
      const contentId = lvm.contentId || '';
      const meta = lvm.metadata?.lockupMetadataViewModel;
      const thumb = lvm.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources ||
                    lvm.contentImage?.thumbnailViewModel?.image?.sources;
      return {
        videoId: contentId,
        title: meta?.title?.content || '',
        thumbnail: getBestThumbnail(thumb),
        channelName: meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || '',
        channelUrl: '',
        channelAvatar: null,
        viewCount: meta?.metadata?.contentMetadataViewModel?.metadataRows?.[1]?.metadataParts?.[0]?.text?.content || '',
        publishedTime: meta?.metadata?.contentMetadataViewModel?.metadataRows?.[1]?.metadataParts?.[1]?.text?.content || '',
        duration: '',
        isLive: false,
      };
    }

    return null;
  }

  function getBestThumbnail(thumbnails) {
    if (!thumbnails || !thumbnails.length) return null;
    // Prefer ~360px wide thumbnail
    const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
    const mid = sorted.find(t => (t.width || 0) >= 320 && (t.width || 0) <= 480);
    return (mid || sorted[0])?.url || null;
  }

  // Recursively find all richItemRenderer items in any nested structure
  function extractRichItems(obj, depth = 0) {
    const items = [];
    if (!obj || typeof obj !== 'object' || depth > 10) return items;

    if (Array.isArray(obj)) {
      for (const el of obj) {
        items.push(...extractRichItems(el, depth + 1));
      }
      return items;
    }

    // Found a richItemRenderer
    if (obj.richItemRenderer?.content) {
      items.push(obj.richItemRenderer.content);
    }

    // Found direct video renderers (subscriptions API format)
    if (obj.videoRenderer) {
      items.push({ videoRenderer: obj.videoRenderer });
    }
    if (obj.gridVideoRenderer) {
      items.push({ videoRenderer: obj.gridVideoRenderer });
    }
    if (obj.compactVideoRenderer) {
      items.push({ videoRenderer: obj.compactVideoRenderer });
    }
    if (obj.lockupViewModel) {
      items.push({ lockupViewModel: obj.lockupViewModel });
    }
    if (obj.shortsLockupViewModel) {
      // Skip shorts for now
    }

    // Recurse into known container keys
    const containerKeys = [
      'contents', 'items', 'content', 'richGridRenderer', 'richShelfRenderer',
      'sectionListRenderer', 'richSectionRenderer', 'itemSectionRenderer',
      'shelfRenderer', 'gridRenderer', 'expandedShelfContentsRenderer',
      'tabRenderer', 'twoColumnBrowseResultsRenderer', 'tabs',
      'horizontalListRenderer', 'verticalListRenderer',
    ];
    for (const key of containerKeys) {
      if (obj[key]) {
        items.push(...extractRichItems(obj[key], depth + 1));
      }
    }

    return items;
  }

  function extractContinuationToken(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 10) return null;
    if (Array.isArray(obj)) {
      for (const el of obj) {
        const token = extractContinuationToken(el, depth + 1);
        if (token) return token;
      }
      return null;
    }
    if (obj.continuationItemRenderer) {
      return obj.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || null;
    }
    for (const key of ['contents', 'items', 'richGridRenderer', 'tabs', 'tabRenderer', 'content']) {
      if (obj[key]) {
        const token = extractContinuationToken(obj[key], depth + 1);
        if (token) return token;
      }
    }
    return null;
  }

  function parseSubscriptionResponse(data, isContinuation = false) {
    const videos = [];
    let continuationToken = null;

    if (isContinuation) {
      // Continuation responses
      const actions = data?.onResponseReceivedActions;
      if (actions) {
        for (const action of actions) {
          const items = action.appendContinuationItemsAction?.continuationItems ||
                        action.reloadContinuationItemsCommand?.continuationItems || [];
          for (const item of items) {
            if (item.richItemRenderer) {
              const video = parseVideoFromRenderer(item.richItemRenderer.content);
              if (video) videos.push(video);
            }
            if (item.continuationItemRenderer) {
              continuationToken = item.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || null;
            }
          }
        }
      }
    } else {
      // Use recursive extraction for robustness against structure changes
      const richItems = extractRichItems(data?.contents);
      console.log('[UTRehome] Found', richItems.length, 'rich items via recursive extraction');

      for (const content of richItems) {
        // Skip ads
        if (content.adSlotRenderer) continue;
        const video = parseVideoFromRenderer(content);
        if (video) videos.push(video);
      }

      continuationToken = extractContinuationToken(data?.contents);
    }

    console.log('[UTRehome] Parsed result:', videos.length, 'videos, continuation:', !!continuationToken);
    if (videos.length > 0) {
      console.log('[UTRehome] First video:', videos[0].title, videos[0].videoId);
    }
    return { videos, continuationToken };
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  function applyGridColumns() {
    const grid = document.querySelector('#utrehome-subscriptions');
    if (grid) {
      grid.style.gridTemplateColumns = `repeat(${state.gridColumns}, minmax(0, 1fr))`;
    }
  }

  function createToggle() {
    const toggle = document.createElement('div');
    toggle.id = 'utrehome-toggle';

    const subsBtn = document.createElement('button');
    subsBtn.className = 'utrehome-tab';
    subsBtn.dataset.view = 'subscriptions';
    subsBtn.textContent = 'Subscriptions';

    const recBtn = document.createElement('button');
    recBtn.className = 'utrehome-tab';
    recBtn.dataset.view = 'recommended';
    recBtn.textContent = 'Recommended';

    const rightGroup = document.createElement('div');
    rightGroup.className = 'utrehome-toggle-right';

    const gridPill = document.createElement('div');
    gridPill.className = 'utrehome-grid-pill';

    const gridDigit = document.createElement('span');
    gridDigit.className = 'utrehome-grid-digit';
    gridDigit.textContent = state.gridColumns;

    const gridBtn = document.createElement('button');
    gridBtn.className = 'utrehome-grid-btn';
    gridBtn.title = 'Change grid columns';
    gridBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 3h8v8H3V3zm0 10h8v8H3v-8zm10-10h8v8h-8V3zm0 10h8v8h-8v-8z"/></svg>';

    gridPill.appendChild(gridDigit);
    gridPill.appendChild(gridBtn);

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'utrehome-refresh-btn';
    refreshBtn.title = 'Refresh subscriptions';
    refreshBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0 0 12 4C7.58 4 4.01 7.58 4.01 12S7.58 20 12 20c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';

    rightGroup.appendChild(gridPill);
    rightGroup.appendChild(refreshBtn);

    toggle.appendChild(subsBtn);
    toggle.appendChild(recBtn);
    toggle.appendChild(rightGroup);

    toggle.addEventListener('click', (e) => {
      const btn = e.target.closest('.utrehome-tab');
      if (!btn || btn.dataset.view === state.currentView) return;
      switchView(btn.dataset.view);
    });

    refreshBtn.addEventListener('click', () => {
      state.cache.videos = [];
      state.cache.continuationToken = null;
      state.cache.fetchedAt = 0;
      state.generation++;
      if (state.currentView === 'subscriptions') {
        loadSubscriptions();
      }
    });

    gridBtn.addEventListener('click', () => {
      const cycle = [3, 4, 5];
      const idx = cycle.indexOf(state.gridColumns);
      state.gridColumns = cycle[(idx + 1) % cycle.length];
      gridDigit.textContent = state.gridColumns;
      applyGridColumns();
    });

    return toggle;
  }

  function createVideoCard(video) {
    const card = document.createElement('div');
    card.className = 'utrehome-video-card';

    const thumbLink = document.createElement('a');
    thumbLink.href = `/watch?v=${video.videoId}`;
    thumbLink.className = 'utrehome-thumb-link';

    const thumbContainer = document.createElement('div');
    thumbContainer.className = 'utrehome-thumbnail';

    if (video.thumbnail) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = video.thumbnail;
      img.alt = video.title;
      thumbContainer.appendChild(img);
    }

    if (video.duration) {
      const badge = document.createElement('span');
      badge.className = 'utrehome-duration';
      badge.textContent = video.duration;
      thumbContainer.appendChild(badge);
    }

    if (video.isLive) {
      const liveBadge = document.createElement('span');
      liveBadge.className = 'utrehome-live-badge';
      liveBadge.textContent = 'LIVE';
      thumbContainer.appendChild(liveBadge);
    }

    thumbLink.appendChild(thumbContainer);
    card.appendChild(thumbLink);

    const meta = document.createElement('div');
    meta.className = 'utrehome-meta';

    if (video.channelAvatar) {
      const avatarLink = document.createElement('a');
      avatarLink.href = video.channelUrl || '#';
      avatarLink.className = 'utrehome-avatar-link';
      const avatar = document.createElement('img');
      avatar.className = 'utrehome-avatar';
      avatar.src = video.channelAvatar;
      avatar.loading = 'lazy';
      avatarLink.appendChild(avatar);
      meta.appendChild(avatarLink);
    }

    const details = document.createElement('div');
    details.className = 'utrehome-details';

    const titleLink = document.createElement('a');
    titleLink.href = `/watch?v=${video.videoId}`;
    titleLink.className = 'utrehome-title';
    titleLink.textContent = video.title;
    titleLink.title = video.title;
    details.appendChild(titleLink);

    if (video.channelName) {
      const channelLink = document.createElement('a');
      channelLink.href = video.channelUrl || '#';
      channelLink.className = 'utrehome-channel';
      channelLink.textContent = video.channelName;
      details.appendChild(channelLink);
    }

    const stats = document.createElement('span');
    stats.className = 'utrehome-stats';
    const parts = [video.viewCount, video.publishedTime].filter(Boolean);
    stats.textContent = parts.join(' \u2022 ');
    details.appendChild(stats);

    meta.appendChild(details);
    card.appendChild(meta);

    return card;
  }

  function renderVideos(videos, container, append = false) {
    if (!append) {
      // Keep sentinel if it exists
      const sentinel = container.querySelector('#utrehome-sentinel');
      container.innerHTML = '';
      if (sentinel) container.appendChild(sentinel);
    }

    const sentinel = container.querySelector('#utrehome-sentinel');

    for (const video of videos) {
      const card = createVideoCard(video);
      if (sentinel) {
        container.insertBefore(card, sentinel);
      } else {
        container.appendChild(card);
      }
    }
  }

  function showError(container, message) {
    container.innerHTML = '';
    const errorDiv = document.createElement('div');
    errorDiv.className = 'utrehome-error';
    errorDiv.innerHTML = `
      <p>${message}</p>
      <button class="utrehome-retry-btn">Retry</button>
    `;
    errorDiv.querySelector('.utrehome-retry-btn').addEventListener('click', () => {
      loadSubscriptions();
    });
    container.appendChild(errorDiv);
  }

  function showNotLoggedIn(container) {
    container.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'utrehome-message';
    msg.innerHTML = `
      <p>Sign in to YouTube to see your subscriptions.</p>
      <p class="utrehome-message-sub">Switch to the "Recommended" tab to browse videos.</p>
    `;
    container.appendChild(msg);
  }

  // ── View Switching ─────────────────────────────────────────────────────

  function switchView(view) {
    state.currentView = view;

    const subsContainer = document.querySelector('#utrehome-subscriptions');
    const originalContents = document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer #contents');
    const chipBar = document.querySelector('ytd-browse[page-subtype="home"] ytd-feed-filter-chip-bar-renderer');
    const header = document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer #header');

    // Update toggle buttons
    document.querySelectorAll('.utrehome-tab').forEach((btn) => {
      btn.classList.toggle('utrehome-tab--active', btn.dataset.view === view);
    });

    // Collapse/expand grid pill based on view
    const gridPill = document.querySelector('.utrehome-grid-pill');
    if (gridPill) {
      gridPill.classList.toggle('utrehome-grid-pill--collapsed', view !== 'subscriptions');
    }

    if (view === 'subscriptions') {
      if (originalContents) originalContents.style.display = 'none';
      if (chipBar) chipBar.style.display = 'none';
      if (header) header.style.display = 'none';
      if (subsContainer) {
        subsContainer.style.display = '';
        applyGridColumns();
        if (!state.cache.videos.length || isCacheStale()) {
          loadSubscriptions();
        }
      }
    } else {
      if (originalContents) originalContents.style.display = '';
      if (chipBar) chipBar.style.display = '';
      if (header) header.style.display = '';
      if (subsContainer) subsContainer.style.display = 'none';
    }

    // Persist preference
    chrome.runtime.sendMessage({ type: 'setDefaultView', view });
  }

  function isCacheStale() {
    return Date.now() - state.cache.fetchedAt > CACHE_LIFETIME;
  }

  // ── Loading Subscriptions ──────────────────────────────────────────────

  async function loadSubscriptions() {
    const gen = state.generation;
    const container = document.querySelector('#utrehome-subscriptions');
    if (!container || state.loading) return;

    state.loading = true;

    // Show loading state
    container.innerHTML = '<div class="utrehome-loading"><div class="utrehome-spinner"></div></div>';

    await injectConfigScript();

    if (gen !== state.generation) { state.loading = false; return; }

    if (!state.config) {
      showError(container, 'Could not load YouTube configuration. Please refresh the page.');
      state.loading = false;
      return;
    }

    if (!state.config.loggedIn) {
      showNotLoggedIn(container);
      state.loading = false;
      return;
    }

    const data = await fetchSubscriptions();
    if (gen !== state.generation) { state.loading = false; return; }

    if (!data) {
      showError(container, 'Failed to load subscriptions. Please try again.');
      state.loading = false;
      return;
    }

    const parsed = parseSubscriptionResponse(data, false);
    state.cache.videos = parsed.videos;
    state.cache.continuationToken = parsed.continuationToken;
    state.cache.fetchedAt = Date.now();

    if (parsed.videos.length === 0) {
      container.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'utrehome-message';
      msg.textContent = 'No subscription videos found. Subscribe to channels to see their videos here.';
      container.appendChild(msg);
      state.loading = false;
      return;
    }

    // Add sentinel for infinite scroll
    let sentinel = container.querySelector('#utrehome-sentinel');
    if (!sentinel) {
      sentinel = document.createElement('div');
      sentinel.id = 'utrehome-sentinel';
      container.appendChild(sentinel);
    }

    renderVideos(parsed.videos, container, false);

    // Ensure sentinel is at the end
    if (sentinel.parentNode === container) {
      container.appendChild(sentinel);
    }

    setupInfiniteScroll();
    state.loading = false;
  }

  async function loadMoreSubscriptions() {
    if (state.loading || !state.cache.continuationToken) return;

    const gen = state.generation;
    state.loading = true;

    const container = document.querySelector('#utrehome-subscriptions');
    if (!container) { state.loading = false; return; }

    const data = await fetchSubscriptions(state.cache.continuationToken);
    if (gen !== state.generation || !data) { state.loading = false; return; }

    const parsed = parseSubscriptionResponse(data, true);
    state.cache.videos.push(...parsed.videos);
    state.cache.continuationToken = parsed.continuationToken;

    renderVideos(parsed.videos, container, true);

    // Move sentinel to end
    const sentinel = container.querySelector('#utrehome-sentinel');
    if (sentinel) container.appendChild(sentinel);

    if (!parsed.continuationToken) {
      // No more content
      if (sentinel) sentinel.remove();
      if (state.scrollObserver) state.scrollObserver.disconnect();
    }

    state.loading = false;
  }

  // ── Infinite Scroll ────────────────────────────────────────────────────

  function setupInfiniteScroll() {
    if (state.scrollObserver) state.scrollObserver.disconnect();

    const sentinel = document.querySelector('#utrehome-sentinel');
    if (!sentinel) return;

    state.scrollObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !state.loading) {
          loadMoreSubscriptions();
        }
      },
      { rootMargin: '600px' }
    );

    state.scrollObserver.observe(sentinel);
  }

  // ── Home Page Lifecycle ────────────────────────────────────────────────

  async function onEnterHomePage() {
    state.isHomePage = true;
    state.generation++;

    const gen = state.generation;

    const browse = await waitForElement('ytd-browse[page-subtype="home"]');
    if (!browse || gen !== state.generation) return;

    const gridRenderer = browse.querySelector('ytd-rich-grid-renderer');
    if (!gridRenderer) return;

    // Get user preference
    const pref = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'getDefaultView' }, (resp) => {
        resolve(resp?.defaultView || 'subscriptions');
      });
    });

    if (gen !== state.generation) return;

    // Create and insert toggle
    let toggle = document.querySelector('#utrehome-toggle');
    if (!toggle) {
      toggle = createToggle();
      const primary = browse.querySelector('#primary');
      if (primary) {
        primary.insertBefore(toggle, primary.firstChild);
      } else {
        gridRenderer.insertBefore(toggle, gridRenderer.firstChild);
      }
    }

    // Create subscription container
    let subsContainer = document.querySelector('#utrehome-subscriptions');
    if (!subsContainer) {
      subsContainer = document.createElement('div');
      subsContainer.id = 'utrehome-subscriptions';
      const contents = gridRenderer.querySelector('#contents');
      if (contents) {
        contents.parentNode.insertBefore(subsContainer, contents);
      } else {
        gridRenderer.appendChild(subsContainer);
      }
    }

    // Apply the preferred view
    state.currentView = pref;
    switchView(pref);

    // Watch for YouTube re-rendering our elements away
    if (state.mutationObserver) state.mutationObserver.disconnect();
    state.mutationObserver = new MutationObserver(() => {
      if (!document.querySelector('#utrehome-toggle') && state.isHomePage) {
        onEnterHomePage();
      }
    });
    state.mutationObserver.observe(gridRenderer, { childList: true });
  }

  function onLeaveHomePage() {
    state.isHomePage = false;
    state.generation++;

    // Abort in-flight fetches
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }

    // Remove our elements
    const toggle = document.querySelector('#utrehome-toggle');
    if (toggle) toggle.remove();

    const subsContainer = document.querySelector('#utrehome-subscriptions');
    if (subsContainer) subsContainer.remove();

    // Restore original content
    const originalContents = document.querySelector('ytd-rich-grid-renderer #contents');
    if (originalContents) originalContents.style.display = '';

    const chipBar = document.querySelector('ytd-feed-filter-chip-bar-renderer');
    if (chipBar) chipBar.style.display = '';

    const header = document.querySelector('ytd-rich-grid-renderer #header');
    if (header) header.style.display = '';

    // Cleanup observers
    if (state.mutationObserver) {
      state.mutationObserver.disconnect();
      state.mutationObserver = null;
    }
    if (state.scrollObserver) {
      state.scrollObserver.disconnect();
      state.scrollObserver = null;
    }

    state.loading = false;
  }

  // ── Initialization ─────────────────────────────────────────────────────

  function checkPage() {
    const nowHome = isHomePage();
    if (nowHome && !state.isHomePage) {
      onEnterHomePage();
    } else if (!nowHome && state.isHomePage) {
      onLeaveHomePage();
    }
  }

  // Listen for refresh message from popup via background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'refreshSubscriptions' && state.isHomePage) {
      state.cache.videos = [];
      state.cache.continuationToken = null;
      state.cache.fetchedAt = 0;
      state.generation++;
      if (state.currentView === 'subscriptions') {
        loadSubscriptions();
      }
    }
  });

  // Listen for YouTube SPA navigations
  document.addEventListener('yt-navigate-finish', checkPage);
  document.addEventListener('yt-navigate-start', () => {
    // Early cleanup to avoid flash of stale content
    if (state.isHomePage) {
      const subsContainer = document.querySelector('#utrehome-subscriptions');
      if (subsContainer) subsContainer.style.display = 'none';
    }
  });

  // Initial check
  checkPage();
})();
