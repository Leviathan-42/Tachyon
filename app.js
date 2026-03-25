const SITES = {
  youtube:  { label: 'YouTube',  url: 'https://www.youtube.com',      iframe: false },
  nilered:  { label: 'NileRed',  url: 'https://www.youtube.com/@NileRed', iframe: false },
  google:   { label: 'Google',   url: 'https://www.google.com',       iframe: false },
  reddit:   { label: 'Reddit',   url: 'https://www.reddit.com',       iframe: false },
  twitch:   { label: 'Twitch',   url: 'https://www.twitch.tv',        iframe: false },
  spotify:  { label: 'Spotify',  url: 'https://open.spotify.com',     iframe: false },
};

function getMethod() {
  return document.querySelector('input[name="method"]:checked').value;
}

function launch(key) {
  const site = SITES[key];
  if (!site) return;
  openUrl(site.url, site.label, site.iframe);
}

function launchCustom() {
  let url = document.getElementById('customUrl').value.trim();
  if (!url) return;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  openUrl(url, url);
}

function openUrl(url, label, allowIframe = true) {
  const method = getMethod();

  if (method === 'iframe' && allowIframe) {
    launchInline(url, label);
  } else if (method === 'aboutblank' || (method === 'iframe' && !allowIframe)) {
    launchAboutBlank(url);
  } else {
    window.open(url, '_blank');
  }
}

// --- about:blank method ---
// for sites that block iframes, just open a real tab and navigate directly
function launchAboutBlank(url) {
  const a = document.createElement('a');
  a.href = url;
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

// allow pressing Enter in custom URL box
document.getElementById('customUrl').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') launchCustom();
});
