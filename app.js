const PROXY = 'http://127.0.0.1:8080';

const SITES = {
  youtube:  { label: 'YouTube',  url: 'https://www.youtube.com' },
  spotify:  { label: 'Spotify',  url: 'https://open.spotify.com' },
  discord:  { label: 'Discord',  url: 'https://discord.com/app' },
  reddit:   { label: 'Reddit',   url: 'https://www.reddit.com' },
  twitch:   { label: 'Twitch',   url: 'https://www.twitch.tv' },
  google:   { label: 'Google',   url: 'https://www.google.com' },
  nilered:  { label: 'NileRed',  url: 'https://www.youtube.com/@NileRed' },
};

function proxyUrl(url) {
  return `${PROXY}/${encodeURIComponent(url)}`;
}

// Default method — overridden by page-level script after this file loads
function getMethod() {
  return 'aboutblank';
}

function launch(key) {
  const site = SITES[key];
  if (!site) return;
  openUrl(site.url, site.label);
}

function launchCustom(method) {
  let url = document.getElementById('customUrl').value.trim();
  if (!url) return;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  openUrl(url, url, method);
}

function openUrl(url, label, forceMethod) {
  const method = forceMethod || getMethod();
  const pUrl = proxyUrl(url);

  if (method === 'aboutblank') {
    launchAboutBlank(pUrl);
  } else if (method === 'iframe') {
    launchInline(pUrl, label);
  } else {
    // direct — no proxy, open the real url
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

// --- about:blank method ---
function launchAboutBlank(url) {
  const a = document.createElement('a');
  a.href = 'loader.html?url=' + encodeURIComponent(url);
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// --- inline iframe method ---
function launchInline(url, label) {
  const container = document.getElementById('inline-container');
  const frame = document.getElementById('inline-frame');
  const labelEl = document.getElementById('inline-label');

  container.classList.remove('hidden');
  frame.src = url;
  labelEl.textContent = label;

  container.scrollIntoView({ behavior: 'smooth' });
}

function closeInline() {
  const container = document.getElementById('inline-container');
  const frame = document.getElementById('inline-frame');
  container.classList.add('hidden');
  frame.src = '';
}
