/**
 * Mom's Sunset Tracker - iOS PWA
 * Core application logic:
 * - Service Worker registration
 * - Geolocation & Open-Meteo Weather API integration
 * - Sunset quality prediction ported directly from sunset.py
 * - IndexedDB storage with Canvas image compression for iOS photo journal
 * - Web Push subscription prep & direct gesture compliance
 */

// Default coordinates ported from sunset.py (Nags Head / Outer Banks, NC)
const DEFAULT_COORDS = {
  lat: 36.077192184101,
  lon: -75.80591489085553,
  label: "Nags Head, NC (Default)"
};

// Placeholder VAPID public key (uncompressed P-256 base64url)
const VAPID_PUBLIC_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDhkWSiYTUr5vq3BgnTwuZJyuo5dP36CcDuBizt2v728';

// State
let currentCoords = { ...DEFAULT_COORDS };
let activeObjectUrls = []; // Track object URLs to revoke and prevent memory leaks
let sunsetDateTime = null;

// ==========================================
// 1. Service Worker Registration
// ==========================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      console.log('[PWA] Service Worker registered successfully with scope:', reg.scope);
      checkExistingPushSubscription(reg);
    } catch (err) {
      console.warn('[PWA] Service Worker registration failed:', err);
    }
  });
}

// ==========================================
// 2. Open-Meteo Weather & Sunset Logic
// ==========================================

/**
 * Ported condition evaluation directly from sunset.py
 * Evaluates rain, low_clouds, high_clouds, and total_clouds
 * averaged across the +/- 30-minute sunset window.
 */
function evaluateSunsetCondition({ rain, low_clouds, high_clouds, total_clouds }) {
  let conditionText = '';
  let tag = '';
  let color = '#ff6b6b';

  if (rain > 0.01 && rain <= 0.1) {
    conditionText = "Looks like it might be drizzling, could get a rainbow if the sun peeks through! 🌈";
    tag = "Rainbow Potential 🌈";
    color = "#f6d365";
  } else if (rain > 0.1) {
    conditionText = "Light rain expected, but it could hold off long enough for a nice sunset! ☔";
    tag = "Light Rain ☔";
    color = "#48dbfb";
  } else if (low_clouds > 70) {
    conditionText = "Thick low clouds might block the horizon today but you never know if the sun might dip below! ☁️";
    tag = "Low Clouds ☁️";
    color = "#a4b0be";
  } else if (low_clouds < 10 && total_clouds > 50) {
    conditionText = "High clouds with a clear horizon could create a fiery red and orange sunset! 🔥";
    tag = "Fiery Sunset 🔥";
    color = "#ff6b6b";
  } else if (high_clouds > 40 && low_clouds < 20) {
    conditionText = "Stunning potential! High cirrus clouds are rolling in—get ready for brilliant pinks and deep purples! 🎨🌅";
    tag = "Vibrant Cirrus 🎨";
    color = "#fd79a8";
  } else if (total_clouds < 10) {
    conditionText = "Clear and pristine skies. Perfect for a classic, glowing sunset. ☀️";
    tag = "Pristine & Clear ☀️";
    color = "#feca57";
  } else {
    conditionText = `Scattered clouds (${Math.round(total_clouds)}% coverage). Could provide some great contrast!`;
    tag = "Scattered Clouds ⛅";
    color = "#ffa502";
  }

  return { conditionText, tag, color };
}

/**
 * Fetch daily sunset time and hourly sky metrics from Open-Meteo API
 */
async function fetchSunsetAndWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=sunset&hourly=temperature_2m,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,rain&timezone=auto&wind_speed_unit=mph&temperature_unit=fahrenheit&precipitation_unit=inch&forecast_days=1`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Open-Meteo API returned HTTP ${res.status}`);
    }
    const data = await res.json();
    processForecastData(data);
  } catch (err) {
    console.error('[Weather] Forecast fetch error:', err);
    showToast('Failed to fetch sky forecast. Check network connection.');
    document.getElementById('sunsetCountdown').textContent = 'Unable to load live weather.';
  }
}

/**
 * Process hourly metrics inside the +/- 30-minute sunset window
 */
function processForecastData(data) {
  if (!data.daily || !data.daily.sunset || !data.daily.sunset[0]) {
    console.error('Invalid forecast response structure:', data);
    return;
  }

  const sunsetIsoStr = data.daily.sunset[0]; // e.g. "2026-10-30T18:14"
  sunsetDateTime = new Date(sunsetIsoStr);

  // Format sunset time for display
  const timeFormatter = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', hour12: true });
  const formattedSunsetTime = timeFormatter.format(sunsetDateTime);

  document.getElementById('sunsetTimeDisplay').textContent = formattedSunsetTime;
  updateCountdown();

  // Hourly arrays
  const hourly = data.hourly;
  const sunsetMs = sunsetDateTime.getTime();
  const windowStartMs = sunsetMs - 30 * 60 * 1000; // -30 min
  const windowEndMs = sunsetMs + 30 * 60 * 1000;   // +30 min

  const matchedIndices = [];
  let closestIndex = 0;
  let minDiff = Infinity;

  for (let i = 0; i < hourly.time.length; i++) {
    const hourDate = new Date(hourly.time[i]);
    const hourMs = hourDate.getTime();
    const diff = Math.abs(hourMs - sunsetMs);

    if (diff < minDiff) {
      minDiff = diff;
      closestIndex = i;
    }

    if (hourMs >= windowStartMs && hourMs <= windowEndMs) {
      matchedIndices.push(i);
    }
  }

  // Fallback to closest hour if no samples fall strictly into the window
  const indicesToAverage = matchedIndices.length > 0 ? matchedIndices : [closestIndex];

  const calcMean = (array) => {
    const sum = indicesToAverage.reduce((acc, idx) => acc + (array[idx] || 0), 0);
    return sum / indicesToAverage.length;
  };

  const temp = calcMean(hourly.temperature_2m);
  const totalClouds = calcMean(hourly.cloud_cover);
  const lowClouds = calcMean(hourly.cloud_cover_low);
  const midClouds = calcMean(hourly.cloud_cover_mid);
  const highClouds = calcMean(hourly.cloud_cover_high);
  const rain = calcMean(hourly.rain);

  // Evaluate conditions using the exact sunset.py rules
  const { conditionText, tag, color } = evaluateSunsetCondition({
    rain,
    low_clouds: lowClouds,
    high_clouds: highClouds,
    total_clouds: totalClouds
  });

  // Render condition card
  const conditionBox = document.getElementById('conditionBox');
  conditionBox.style.borderLeftColor = color;

  const conditionTagEl = document.getElementById('conditionTag');
  conditionTagEl.textContent = tag;
  conditionTagEl.style.color = color;

  document.getElementById('conditionText').textContent = conditionText;

  // Format exact message body from sunset.py
  const momMessage = `Hi Mom! Today's sunset is at ${formattedSunsetTime}.\n\n${conditionText}\nTemp: ${temp.toFixed(1)}°F`;
  document.getElementById('momMessagePreview').textContent = momMessage;

  // Update metrics grid
  document.getElementById('valTemp').textContent = `${temp.toFixed(1)}°F`;
  document.getElementById('barTemp').style.width = `${Math.min(100, Math.max(0, (temp - 32) * 1.5))}%`;

  document.getElementById('valTotalClouds').textContent = `${Math.round(totalClouds)}%`;
  document.getElementById('barTotalClouds').style.width = `${Math.min(100, totalClouds)}%`;

  document.getElementById('valLowClouds').textContent = `${Math.round(lowClouds)}%`;
  document.getElementById('barLowClouds').style.width = `${Math.min(100, lowClouds)}%`;

  document.getElementById('valMidClouds').textContent = `${Math.round(midClouds)}%`;
  document.getElementById('barMidClouds').style.width = `${Math.min(100, midClouds)}%`;

  document.getElementById('valHighClouds').textContent = `${Math.round(highClouds)}%`;
  document.getElementById('barHighClouds').style.width = `${Math.min(100, highClouds)}%`;

  document.getElementById('valRain').textContent = `${rain.toFixed(2)} in`;
  document.getElementById('barRain').style.width = `${Math.min(100, rain * 200)}%`;
}

function updateCountdown() {
  if (!sunsetDateTime) return;
  const now = new Date();
  const diffMinutes = Math.round((sunsetDateTime.getTime() - now.getTime()) / (60 * 1000));
  const countdownEl = document.getElementById('sunsetCountdown');

  if (diffMinutes > 60) {
    const hours = Math.floor(diffMinutes / 60);
    const mins = diffMinutes % 60;
    countdownEl.textContent = `🌅 In ${hours}h ${mins}m (Tonight)`;
  } else if (diffMinutes > 0) {
    countdownEl.textContent = `🚨 Starting in ${diffMinutes} minutes! Head outside!`;
  } else if (diffMinutes >= -45) {
    countdownEl.textContent = `✨ Sunset is happening right now! Enjoy the sky!`;
  } else {
    countdownEl.textContent = `🌙 Sunset was ${Math.abs(diffMinutes)} minutes ago.`;
  }
}

// Keep countdown fresh every minute
setInterval(updateCountdown, 60000);

// ==========================================
// 3. Geolocation & Location Updates
// ==========================================

function updateCoordinateDisplay(lat, lon, label) {
  const coordText = document.getElementById('coordText');
  const latStr = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
  coordText.textContent = `${latStr}, ${lonStr} ${label ? `(${label})` : ''}`;
}

/**
 * Handle user tap on "Update Location & Enable Sunset Alerts"
 * Must be triggered by direct user gesture for iOS Web Push
 */
async function handleUpdateLocationAndAlerts() {
  const btn = document.getElementById('enableAlertsBtn');
  const originalText = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span> Updating Location & Alerts...`;
  btn.disabled = true;

  try {
    // 1. Request Geolocation
    if ('geolocation' in navigator) {
      await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            currentCoords = {
              lat: position.coords.latitude,
              lon: position.coords.longitude,
              label: "Live GPS"
            };
            localStorage.setItem('sunset_saved_coords', JSON.stringify(currentCoords));
            updateCoordinateDisplay(currentCoords.lat, currentCoords.lon, currentCoords.label);
            fetchSunsetAndWeather(currentCoords.lat, currentCoords.lon);
            resolve();
          },
          (err) => {
            console.warn('[Location] Geolocation denied or unavailable:', err.message);
            showToast('Using default coordinates (Nags Head, NC).');
            currentCoords = { ...DEFAULT_COORDS };
            updateCoordinateDisplay(currentCoords.lat, currentCoords.lon, currentCoords.label);
            fetchSunsetAndWeather(currentCoords.lat, currentCoords.lon);
            resolve();
          },
          { timeout: 10000, enableHighAccuracy: true }
        );
      });
    } else {
      showToast('Geolocation not supported on this device. Using default coordinates.');
    }

    // 2. Trigger Push Subscription under direct user interaction
    await subscribeUserToPush(currentCoords.lat, currentCoords.lon);
  } catch (error) {
    console.error('Error during update location and alerts:', error);
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

// ==========================================
// 4. Web Push Notification Preparation
// ==========================================

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function checkExistingPushSubscription(registration) {
  if (!('PushManager' in window) || !registration) return;
  try {
    const sub = await registration.pushManager.getSubscription();
    const badge = document.getElementById('pushBadge');
    const badgeText = document.getElementById('pushStatusText');
    if (sub) {
      badge.className = 'push-status-badge granted';
      badgeText.textContent = 'Push Alerts: Subscribed & Active';
    } else if (Notification.permission === 'denied') {
      badge.className = 'push-status-badge denied';
      badgeText.textContent = 'Push Alerts: Notifications Blocked';
    }
  } catch (err) {
    console.warn('Error checking push subscription:', err);
  }
}

/**
 * Placeholder function to subscribe user to Web Push
 * Logs subscription JSON and monitored coordinates for backend integration
 */
async function subscribeUserToPush(lat, lon) {
  const badge = document.getElementById('pushBadge');
  const badgeText = document.getElementById('pushStatusText');

  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    badgeText.textContent = 'Push Alerts: Not supported in browser';
    showToast('Push Notifications not supported in this browser mode.');
    return;
  }

  // Check iOS Standalone requirement
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

  if (isIos && !isStandalone) {
    showToast('Add app to Home Screen (Share -> Add to Home Screen) for iOS alerts.');
  }

  try {
    // Direct user-tap permission prompt
    const permission = await Notification.requestPermission();
    console.log('[Push] Notification permission result:', permission);

    if (permission !== 'granted') {
      badge.className = 'push-status-badge denied';
      badgeText.textContent = 'Push Alerts: Permission Denied';
      showToast('Notification permission was denied.');
      return;
    }

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }

    const subscriptionJson = subscription.toJSON();

    // Log payload for database wiring next
    console.log('=== Web Push Subscription Ready ===');
    console.log('Coordinates:', { lat, lon });
    console.log('Subscription JSON:', JSON.stringify(subscriptionJson, null, 2));
    console.log('===================================');

    badge.className = 'push-status-badge granted';
    badgeText.textContent = 'Push Alerts: Active & Monitored';
    showToast('Sunset alerts enabled! Subscription logged for backend wiring.');
  } catch (err) {
    console.error('[Push] Subscription failed:', err);
    badgeText.textContent = 'Push Alerts: Error Subscribing';
    showToast(`Push subscription setup error: ${err.message}`);
  }
}

// ==========================================
// 5. IndexedDB Photo Storage & Canvas Resizing
// ==========================================

const DB_NAME = 'SunsetPhotosDB';
const DB_VERSION = 1;
const STORE_NAME = 'photos';

function openPhotosDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

async function savePhotoRecord(record) {
  const db = await openPhotosDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllPhotosFromDB() {
  const db = await openPhotosDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function deletePhotoFromDB(id) {
  const db = await openPhotosDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Compress and downscale camera/library photo via HTML5 Canvas
 * Prevents 12MP-48MP iPhone images from overflowing Safari IDB limits
 */
async function compressImageFile(file, maxDimension = 1400, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read photo file.'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to parse photo image data.'));
      img.onload = () => {
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;

        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Canvas toBlob conversion failed.'));
            }
          },
          'image/jpeg',
          quality
        );
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Handle new photo snapped or selected
 */
async function handlePhotoSelected(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  showToast('Compressing and saving sunset photo...');

  try {
    const compressedBlob = await compressImageFile(file, 1400, 0.82);

    const now = new Date();
    const dateFormatted = now.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });

    const record = {
      id: Date.now(),
      blob: compressedBlob,
      timestamp: Date.now(),
      dateFormatted
    };

    await savePhotoRecord(record);
    showToast('Sunset photo saved to your journal! 📸');
    await renderGallery();
  } catch (err) {
    console.error('Error saving photo:', err);
    showToast('Could not save photo: ' + err.message);
  } finally {
    event.target.value = ''; // Reset input to allow snapping again
  }
}

/**
 * Render all photos from IndexedDB into the gallery grid
 */
async function renderGallery() {
  const galleryEl = document.getElementById('photoGallery');
  const countBadge = document.getElementById('photoCountBadge');

  // Clean up existing object URLs to avoid memory leakage
  activeObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  activeObjectUrls = [];

  try {
    const photos = await getAllPhotosFromDB();
    photos.sort((a, b) => b.timestamp - a.timestamp); // newest first

    countBadge.textContent = `${photos.length} photo${photos.length === 1 ? '' : 's'}`;

    if (photos.length === 0) {
      galleryEl.innerHTML = `
        <div class="gallery-empty" id="galleryEmpty">
          <span class="gallery-empty-icon">🌅</span>
          No sunset photos saved yet.<br>Snap today's horizon to start your journal!
        </div>
      `;
      return;
    }

    galleryEl.innerHTML = '';

    photos.forEach((photo) => {
      const objUrl = URL.createObjectURL(photo.blob);
      activeObjectUrls.push(objUrl);

      const itemEl = document.createElement('div');
      itemEl.className = 'photo-item';

      const imgEl = document.createElement('img');
      imgEl.className = 'photo-img';
      imgEl.src = objUrl;
      imgEl.alt = `Sunset captured on ${photo.dateFormatted}`;
      imgEl.loading = 'lazy';
      imgEl.addEventListener('click', () => openPhotoModal(objUrl, photo.dateFormatted));

      const overlayEl = document.createElement('div');
      overlayEl.className = 'photo-overlay';

      const dateEl = document.createElement('span');
      dateEl.className = 'photo-date';
      dateEl.textContent = photo.dateFormatted;

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-delete-photo';
      delBtn.innerHTML = '🗑️';
      delBtn.title = 'Delete photo';
      delBtn.setAttribute('aria-label', 'Delete photo');
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm('Delete this sunset photo from your journal?')) {
          await deletePhotoFromDB(photo.id);
          showToast('Photo deleted.');
          renderGallery();
        }
      });

      overlayEl.appendChild(dateEl);
      overlayEl.appendChild(delBtn);

      itemEl.appendChild(imgEl);
      itemEl.appendChild(overlayEl);

      galleryEl.appendChild(itemEl);
    });
  } catch (err) {
    console.error('Failed to render gallery:', err);
  }
}

// ==========================================
// 6. UI Helpers (Modal, Toast, Events)
// ==========================================

function openPhotoModal(src, caption) {
  const modal = document.getElementById('photoModal');
  const modalImg = document.getElementById('modalImg');
  const modalCaption = document.getElementById('modalCaption');

  modalImg.src = src;
  modalCaption.textContent = caption || '';
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
}

function closePhotoModal() {
  const modal = document.getElementById('photoModal');
  modal.classList.remove('active');
  modal.setAttribute('aria-hidden', 'true');
}

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById('toastMessage');
  toast.textContent = message;
  toast.classList.add('show');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 3200);
}

// ==========================================
// 7. Initial Setup & Event Listeners
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
  // Check for saved coordinates in localStorage
  const saved = localStorage.getItem('sunset_saved_coords');
  if (saved) {
    try {
      currentCoords = JSON.parse(saved);
    } catch (e) {
      currentCoords = { ...DEFAULT_COORDS };
    }
  }

  updateCoordinateDisplay(currentCoords.lat, currentCoords.lon, currentCoords.label);
  fetchSunsetAndWeather(currentCoords.lat, currentCoords.lon);
  renderGallery();

  // Attach button events
  const enableAlertsBtn = document.getElementById('enableAlertsBtn');
  if (enableAlertsBtn) {
    enableAlertsBtn.addEventListener('click', handleUpdateLocationAndAlerts);
  }

  const refreshBtn = document.getElementById('refreshWeatherBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      showToast('Refreshing weather & sunset forecast...');
      fetchSunsetAndWeather(currentCoords.lat, currentCoords.lon);
    });
  }

  // Camera & Photo Library Input Listeners
  const cameraInput = document.getElementById('cameraInput');
  if (cameraInput) {
    cameraInput.addEventListener('change', handlePhotoSelected);
  }

  const libraryInput = document.getElementById('libraryInput');
  if (libraryInput) {
    libraryInput.addEventListener('change', handlePhotoSelected);
  }

  // Modal Close Listeners
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const modal = document.getElementById('photoModal');
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', closePhotoModal);
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closePhotoModal();
    });
  }
});

