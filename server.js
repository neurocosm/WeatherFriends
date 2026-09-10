import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Read current App Build Version from version.json (Single True Source of Truth)
function getAppVersion() {
  try {
    const versionFilePath = path.join(__dirname, 'version.json');
    if (fs.existsSync(versionFilePath)) {
      const data = JSON.parse(fs.readFileSync(versionFilePath, 'utf8'));
      if (data && data.version) return data.version;
    }
  } catch (e) {}
  return 'v1.090726.2052';
}

const BUILD_TIMESTAMP = Date.now();

// Serve static files with anti-cache headers for HTML, SW, and version manifest
app.use((req, res, next) => {
  // Prevent Smart TV and browser aggressive caching of entry point, service worker, and version
  if (req.path === '/' || req.path === '/index.html' || req.path === '/sw.js' || req.path === '/version.json' || req.path === '/manifest.json' || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Single True Source: Serve index.html with live version injected from version.json
function serveIndexHtml(req, res) {
  const version = getAppVersion();
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return res.status(500).send('Error loading page');
    // Ensure all references match version.json exactly
    const injected = html
      .replace(/const CLIENT_APP_VERSION = 'v1\.[^']+';/, `const CLIENT_APP_VERSION = '${version}';`)
      .replace(/<span id="appVersionText">v1\.[^<]+<\/span>/, `<span id="appVersionText">${version}</span>`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-revalidate, max-age=0');
    res.send(injected);
  });
}

// Single True Source: Serve sw.js with live CACHE_NAME injected from version.json
function serveServiceWorker(req, res) {
  const version = getAppVersion();
  const filePath = path.join(__dirname, 'sw.js');
  fs.readFile(filePath, 'utf8', (err, swCode) => {
    if (err) return res.status(500).send('Error loading service worker');
    const injected = swCode.replace(/const CACHE_NAME = '[^']+';/, `const CACHE_NAME = 'wf-${version}';`);
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-revalidate, max-age=0');
    res.send(injected);
  });
}

app.get('/', serveIndexHtml);
app.get('/index.html', serveIndexHtml);
app.get('/sw.js', serveServiceWorker);

// Serve static files from the root directory
app.use(express.static(__dirname));

// Version endpoint for remote PWA update detection (always reflects Eastern Time)
app.get('/api/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const currentVersion = getAppVersion();
  res.json({
    version: currentVersion,
    timezone: 'America/New_York (EDT/EST)',
    timestamp: BUILD_TIMESTAMP,
    serverTime: Date.now()
  });
});

// Server-side IP Geolocation fallback (avoids browser adblocker / CORS blocks)
app.get('/api/location', async (req, res) => {
  try {
    const rawIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const isLocal = !rawIp || rawIp === '127.0.0.1' || rawIp === '::1' || rawIp.startsWith('10.') || rawIp.startsWith('192.168.');
    const queryIp = isLocal ? '' : rawIp;

    // Try ipwho.is first
    const ipRes = await fetch(`https://ipwho.is/${queryIp}`, {
      headers: { 'User-Agent': 'WeatherFriendsConsole/1.0' }
    });
    const ipData = await ipRes.json();
    if (ipData && ipData.success) {
      return res.json({
        success: true,
        lat: ipData.latitude,
        lon: ipData.longitude,
        city: `${ipData.city}, ${ipData.region_code || ipData.region || ipData.country}`
      });
    }
  } catch (err) {
    console.error('IP geolocate error:', err.message);
  }

  // Graceful fallback baseline (e.g. San Francisco or New York)
  res.json({
    success: true,
    lat: 37.7749,
    lon: -122.4194,
    city: 'San Francisco, CA'
  });
});

// Server-side reverse geocode with high precision (zoom=18)
app.get('/api/reverse-geocode', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

  try {
    // Primary: OpenStreetMap / Nominatim with zoom 18 for neighborhood/city level precision
    const nomRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`, {
      headers: { 'User-Agent': 'WeatherFriendsConsole/1.1 (neurocosm@gmail.com)' }
    });
    if (nomRes.ok) {
      const j = await nomRes.json();
      const a = j.address || {};
      // Prioritize actual incorporated city or town over overarching county/metro
      const city = a.city || a.town || a.village || a.municipality || a.suburb || a.hamlet || a.county;
      const state = a['ISO3166-2-lvl4'] ? a['ISO3166-2-lvl4'].replace(/^US-/, '') : (a.state || a.country || '');
      if (city) {
        return res.json({ city: state && state !== city ? `${city}, ${state}` : city });
      }
    }
  } catch (err) {
    console.error('Nominatim reverse error:', err.message);
  }

  res.json({ city: 'Current Location' });
});

// Search location by City Name, US ZIP, Canadian Postal Code, or International City
app.get('/api/search-location', async (req, res) => {
  const query = req.query.q?.trim();
  if (!query) return res.status(400).json({ results: [] });

  try {
    // 1. If it looks like a 5-digit US zip code
    if (/^\d{5}$/.test(query)) {
      try {
        const zipRes = await fetch(`https://api.zippopotam.us/us/${query}`);
        if (zipRes.ok) {
          const zd = await zipRes.json();
          const place = zd.places?.[0];
          if (place) {
            return res.json({
              results: [{
                name: `${place['place name']}, ${place['state abbreviation']}`,
                lat: parseFloat(place.latitude),
                lon: parseFloat(place.longitude),
                country: 'United States',
                countryCode: 'US',
                admin1: place['state abbreviation']
              }]
            });
          }
        }
      } catch (e) {
        // fallback to open-meteo
      }
    }

    // 2. If it looks like a Canadian postal code (e.g. M5V or M5V 2T6 or K1A0B1)
    const cleanCa = query.replace(/\s+/g, '').toUpperCase();
    if (/^[A-Z]\d[A-Z](?:\d[A-Z]\d)?$/.test(cleanCa)) {
      try {
        const fsa = cleanCa.slice(0, 3);
        const caRes = await fetch(`https://api.zippopotam.us/ca/${fsa}`);
        if (caRes.ok) {
          const cd = await caRes.json();
          const place = cd.places?.[0];
          if (place) {
            const shortPlace = place['place name'].split('(')[0].trim();
            return res.json({
              results: [{
                name: `${shortPlace}, ${place['state abbreviation']}, Canada`,
                lat: parseFloat(place.latitude),
                lon: parseFloat(place.longitude),
                country: 'Canada',
                countryCode: 'CA',
                admin1: place['state abbreviation']
              }]
            });
          }
        }
      } catch (e) {
        // fallback to open-meteo
      }
    }

    // 3. Open-Meteo Geocoding (Global coverage)
    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=en&format=json`);
    if (geoRes.ok) {
      const gd = await geoRes.json();
      if (gd.results && gd.results.length > 0) {
        const list = gd.results.map(r => ({
          name: `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}${r.country_code ? ' (' + r.country_code + ')' : ''}`,
          lat: r.latitude,
          lon: r.longitude,
          country: r.country || r.country_code || '',
          countryCode: (r.country_code || '').toUpperCase(),
          admin1: r.admin1 || '',
          timezone: r.timezone || ''
        }));
        return res.json({ results: list });
      }
    }
  } catch (err) {
    console.error('Geocoding search error:', err.message);
  }

  res.json({ results: [] });
});

// Free Inspiration API (Positive Quotes, Philosophy / Stoic, Scripture / Biblical)
const RECENT_QUOTES = new Set();
const RECENT_QUEUE = [];
const MAX_RECENT = 75;

function isRecentlyServed(text) {
  if (!text) return false;
  const key = text.slice(0, 40).toLowerCase().trim();
  return RECENT_QUOTES.has(key);
}

function recordServedQuote(text) {
  if (!text) return;
  const key = text.slice(0, 40).toLowerCase().trim();
  RECENT_QUOTES.add(key);
  RECENT_QUEUE.push(key);
  if (RECENT_QUEUE.length > MAX_RECENT) {
    const oldest = RECENT_QUEUE.shift();
    RECENT_QUOTES.delete(oldest);
  }
}

const INSPIRATION_FALLBACKS = {
  positive: [
    { text: "Wherever you go, no matter what the weather, always bring your own sunshine.", author: "Anthony J. D'Angelo" },
    { text: "Do what you can, with what you have, where you are.", author: "Theodore Roosevelt" },
    { text: "Keep your face always toward the sunshine, and shadows will fall behind you.", author: "Walt Whitman" },
    { text: "Every day may not be good, but there is something good in every day.", author: "Alice Morse Earle" },
    { text: "Start where you are. Use what you have. Do what you can.", author: "Arthur Ashe" },
    { text: "Act as if what you do makes a difference. It does.", author: "William James" },
    { text: "It always seems impossible until it's done.", author: "Nelson Mandela" },
    { text: "Believe you can and you're halfway there.", author: "Theodore Roosevelt" },
    { text: "A warm smile is the universal language of kindness.", author: "William Arthur Ward" },
    { text: "Happiness is not by chance, but by choice.", author: "Jim Rohn" },
    { text: "You are never too old to set another goal or to dream a new dream.", author: "C.S. Lewis" },
    { text: "Optimism is a happiness magnet. If you stay positive, good things will be drawn to you.", author: "Mary Lou Retton" },
    { text: "The best way to predict the future is to create it.", author: "Peter Drucker" },
    { text: "Spread love everywhere you go. Let no one ever come to you without leaving happier.", author: "Mother Teresa" },
    { text: "In the middle of difficulty lies opportunity.", author: "Albert Einstein" },
    { text: "What lies behind us and what lies before us are tiny matters compared to what lies within us.", author: "Ralph Waldo Emerson" },
    { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
    { text: "Joy is not in things; it is in us.", author: "Richard Wagner" },
    { text: "Your time is limited, so don't waste it living someone else's life.", author: "Steve Jobs" },
    { text: "Turn your wounds into wisdom.", author: "Oprah Winfrey" }
  ],
  philosophy: [
    { text: "You have power over your mind - not outside events. Realize this, and you will find strength.", author: "Marcus Aurelius" },
    { text: "We suffer more often in imagination than in reality.", author: "Seneca" },
    { text: "Waste no more time arguing about what a good man should be. Be one.", author: "Marcus Aurelius" },
    { text: "No person has the power to have everything they want, but it is in their power not to want what they haven't.", author: "Seneca" },
    { text: "The unexamined life is not worth living.", author: "Socrates" },
    { text: "Nature does not hurry, yet everything is accomplished.", author: "Lao Tzu" },
    { text: "It is the mark of an educated mind to be able to entertain a thought without accepting it.", author: "Aristotle" },
    { text: "First say to yourself what you would be; and then do what you have to do.", author: "Epictetus" },
    { text: "When you arise in the morning think of what a privilege it is to be alive: to breathe, to think, to enjoy, to love.", author: "Marcus Aurelius" },
    { text: "The key is to keep company only with people who uplift you, whose presence calls forth your best.", author: "Epictetus" },
    { text: "Happiness resides not in possessions, and not in gold, happiness dwells in the soul.", author: "Democritus" },
    { text: "He who has a why to live can bear almost any how.", author: "Friedrich Nietzsche" },
    { text: "Knowing others is wisdom, knowing yourself is enlightenment.", author: "Lao Tzu" },
    { text: "Dwell on the beauty of life. Watch the stars, and see yourself running with them.", author: "Marcus Aurelius" },
    { text: "Difficulties strengthen the mind, as labor does the body.", author: "Seneca" },
    { text: "Wealth consists not in having great possessions, but in having few wants.", author: "Epictetus" },
    { text: "It is not that we have a short time to live, but that we waste a lot of it.", author: "Seneca" },
    { text: "Man conquers the world by conquering himself.", author: "Zeno of Citium" }
  ],
  scripture: [
    { text: "For I know the plans I have for you, declares the Lord, plans for peace and not for evil, to give you a future and a hope.", author: "Jeremiah 29:11" },
    { text: "Trust in the Lord with all your heart, and do not lean on your own understanding. In all your ways acknowledge him, and he will make straight your paths.", author: "Proverbs 3:5-6" },
    { text: "I can do all things through him who strengthens me.", author: "Philippians 4:13" },
    { text: "The Lord is my shepherd; I shall not want. He makes me lie down in green pastures. He leads me beside still waters.", author: "Psalm 23:1-2" },
    { text: "Be strong and courageous. Do not be afraid; do not be discouraged, for the Lord your God will be with you wherever you go.", author: "Joshua 1:9" },
    { text: "And we know that in all things God works for the good of those who love him.", author: "Romans 8:28" },
    { text: "Those who hope in the Lord will renew their strength. They will soar on wings like eagles; they will run and not grow weary.", author: "Isaiah 40:31" },
    { text: "Cast all your anxiety on him because he cares for you.", author: "1 Peter 5:7" },
    { text: "This is the day that the Lord has made; let us rejoice and be glad in it.", author: "Psalm 118:24" },
    { text: "Love is patient, love is kind. It does not envy, it does not boast, it is not proud.", author: "1 Corinthians 13:4" },
    { text: "Let all that you do be done in love.", author: "1 Corinthians 16:14" },
    { text: "The peace of God, which transcends all understanding, will guard your hearts and your minds in Christ Jesus.", author: "Philippians 4:7" },
    { text: "Come to me, all you who are weary and burdened, and I will give you rest.", author: "Matthew 11:28" },
    { text: "God is our refuge and strength, an ever-present help in trouble.", author: "Psalm 46:1" },
    { text: "The steadfast love of the Lord never ceases; his mercies never come to an end; they are new every morning.", author: "Lamentations 3:22-23" },
    { text: "For where your treasure is, there your heart will be also.", author: "Matthew 6:21" },
    { text: "Your word is a lamp for my feet, a light on my path.", author: "Psalm 119:105" },
    { text: "For we walk by faith, not by sight.", author: "2 Corinthians 5:7" },
    { text: "Whatever is true, whatever is noble, whatever is right, whatever is pure, whatever is lovely, think about such things.", author: "Philippians 4:8" }
  ]
};

const EXPANDED_SCRIPTURE_PASSAGES = [
  'Jeremiah 29:11', 'Proverbs 3:5-6', 'Philippians 4:13', 'Psalm 23:1-4',
  'Joshua 1:9', 'Romans 8:28', 'Isaiah 40:31', '1 Peter 5:7',
  'Psalm 118:24', '1 Corinthians 13:4-8', 'Matthew 6:33-34', 'Psalm 46:1-3',
  'Philippians 4:6-7', 'Proverbs 16:3', 'Proverbs 16:9', 'Psalm 91:1-2',
  'Psalm 121:1-2', 'Matthew 11:28-30', 'Galatians 5:22-23', 'Romans 12:2',
  'Romans 12:12', 'Colossians 3:12-14', 'Ephesians 4:32', 'Psalm 139:13-14',
  'Psalm 27:1', 'Psalm 37:4-5', 'Lamentations 3:22-23', 'Micah 6:8',
  'Zephaniah 3:17', '2 Timothy 1:7', 'Hebrews 11:1', 'James 1:2-3',
  '1 Thessalonians 5:16-18', 'John 14:27', 'John 16:33', 'Isaiah 41:10',
  'Psalm 34:8', 'Psalm 103:1-4', 'Deuteronomy 31:6', 'Psalm 119:105'
];

app.get('/api/inspiration', async (req, res) => {
  const type = (req.query.type || 'positive').toLowerCase();
  const pool = INSPIRATION_FALLBACKS[type] || INSPIRATION_FALLBACKS.positive;

  // Helper to safely execute fetch with timeout
  const timedFetch = async (url, options = {}, timeoutMs = 3800) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return resp;
    } catch (e) {
      clearTimeout(timer);
      return null;
    }
  };

  try {
    if (type === 'scripture') {
      // Tier 1: OurManna Random Verse API (Rich curated library of inspiring NIV verses)
      const omRes = await timedFetch('https://beta.ourmanna.com/api/v1/get?format=json&order=random');
      if (omRes && omRes.ok) {
        const omData = await omRes.json();
        const details = omData?.verse?.details;
        if (details && details.text && details.reference) {
          const cleanText = details.text.replace(/\s+/g, ' ').trim();
          const cleanAuthor = `${details.reference}${details.version ? ' (' + details.version + ')' : ''}`;
          if (!isRecentlyServed(cleanText)) {
            recordServedQuote(cleanText);
            return res.json({ text: cleanText, author: cleanAuthor, category: 'scripture' });
          }
        }
      }

      // Tier 2: Bible-API.com with dynamic passage list
      const randomPassage = EXPANDED_SCRIPTURE_PASSAGES[Math.floor(Math.random() * EXPANDED_SCRIPTURE_PASSAGES.length)];
      const bRes = await timedFetch(`https://bible-api.com/${encodeURIComponent(randomPassage)}`);
      if (bRes && bRes.ok) {
        const bData = await bRes.json();
        if (bData && bData.text) {
          const cleanText = bData.text.replace(/\s+/g, ' ').trim();
          recordServedQuote(cleanText);
          return res.json({ text: cleanText, author: bData.reference, category: 'scripture' });
        }
      }
    } else if (type === 'philosophy') {
      // Tier 1: Stoic Quotes API (Marcus Aurelius, Seneca, Epictetus)
      const sqRes = await timedFetch('https://stoic-quotes.com/api/quote');
      if (sqRes && sqRes.ok) {
        const sqData = await sqRes.json();
        if (sqData && sqData.text) {
          const cleanText = sqData.text.replace(/\s+/g, ' ').trim();
          if (!isRecentlyServed(cleanText)) {
            recordServedQuote(cleanText);
            return res.json({ text: cleanText, author: sqData.author || 'Stoic Wisdom', category: 'philosophy' });
          }
        }
      }

      // Tier 2: ZenQuotes API
      const zRes = await timedFetch('https://zenquotes.io/api/random');
      if (zRes && zRes.ok) {
        const zData = await zRes.json();
        if (Array.isArray(zData) && zData[0] && zData[0].q) {
          const cleanText = zData[0].q.replace(/\s+/g, ' ').trim();
          recordServedQuote(cleanText);
          return res.json({ text: cleanText, author: zData[0].a || 'Philosopher', category: 'philosophy' });
        }
      }
    } else {
      // Positive / Motivational Quotes
      // Tier 1: DummyJSON quotes (1400+ quotes)
      const djRes = await timedFetch('https://dummyjson.com/quotes/random');
      if (djRes && djRes.ok) {
        const djData = await djRes.json();
        if (djData && djData.quote) {
          const cleanText = djData.quote.replace(/\s+/g, ' ').trim();
          if (!isRecentlyServed(cleanText)) {
            recordServedQuote(cleanText);
            return res.json({ text: cleanText, author: djData.author || 'Inspirational', category: 'positive' });
          }
        }
      }

      // Tier 2: ZenQuotes API
      const zRes = await timedFetch('https://zenquotes.io/api/random');
      if (zRes && zRes.ok) {
        const zData = await zRes.json();
        if (Array.isArray(zData) && zData[0] && zData[0].q) {
          const cleanText = zData[0].q.replace(/\s+/g, ' ').trim();
          recordServedQuote(cleanText);
          return res.json({ text: cleanText, author: zData[0].a || 'Inspirational', category: 'positive' });
        }
      }
    }
  } catch (err) {
    console.warn(`[Inspiration API] Live fetch error for ${type}:`, err.message);
  }

  // Graceful fallback from expanded pool prioritizing non-recently served items
  const unserved = pool.filter(item => !isRecentlyServed(item.text));
  const candidatePool = unserved.length > 0 ? unserved : pool;
  const item = candidatePool[Math.floor(Math.random() * candidatePool.length)];
  recordServedQuote(item.text);
  res.json({ text: item.text, author: item.author, category: type });
});

// Checkiday Daily Holidays API Proxy & Caching
let checkidayCache = {
  dateKey: null,
  fetchedAt: 0,
  holidays: []
};

const CURATED_ORIGINS = {
  // September 6 Holidays
  'barbie doll day': 'Marks the anniversary of the day that the Barbie doll first went on sale in 1959, created by Mattel co-founder Ruth Handler.',
  'fight procrastination day': 'A dedicated day encouraging everyone to overcome delay, get organized, and tackle that long-overdue project today.',
  'great egg toss day': 'Celebrates the classic outdoor lawn game and partner coordination challenge enjoyed at picnics and fairs everywhere.',
  'national coffee ice cream day': 'Honoring the creamy, caffeinated dessert favorite blending rich espresso and sweet cream, first recorded in the early 20th century.',
  'national pastor\'s spouses day': 'Observed on the first Sunday of September to recognize and appreciate the steadfast support and guidance of ministry partners.',
  'national read a book day': 'Observed annually on September 6, encouraging people of all ages to step away from screens and get lost in a good book.',
  'pet rock day': 'Celebrates Gary Dahl\'s humorous 1975 creation that became one of the most famous, low-maintenance fads in toy history.',
  'stillbirth remembrance day': 'Observed annually on September 6 to honor memories and support grieving families with compassion, awareness, and care.',
  // Additional September dates
  'franchise appreciation day': 'Observed on the Saturday before Labor Day since 2011 to celebrate local franchise owners and community businesses.',
  'international bacon day': 'Created in 2004 by CU Boulder graduate students and celebrated the Saturday before Labor Day with friends and feasts.',
  'international day of charity': 'Established by the United Nations General Assembly to mobilize volunteering, community aid, and humanitarian support worldwide.',
  'international vulture awareness day': 'Founded by conservation trusts in South Africa and England to highlight vital raptor preservation and biodiversity.',
  'national be late for something day': 'Created by the Procrastinator\'s Club of America in 1956 as a playful excuse to slow down, relax, and take in the moment.',
  'national cheese pizza day': 'Honoring the classic flatbread pie first enjoyed in 18th-century Naples and brought to America by early 20th-century immigrants.',
  'national hummingbird day': 'Celebrating the incredible agility and beauty of more than 320 species of nature\'s smallest and most vibrant pollinators.',
  'national shrink day': 'Honors psychologists and psychiatrists on September 5, celebrating Bob Newhart\'s birthday and his famous TV therapist role.',
  'national tailgating day': 'Celebrating pregame food, grilling, and fan camaraderie outside stadiums on the first Saturday of September.',
  'world beard day': 'Observed on the first Saturday in September as a global celebration of facial hair, grooming traditions, and camaraderie.',
  'world samosa day': 'Dedicated to the crispy, savory spiced pastry originating in Central Asia and celebrated across global street food cultures.'
};

const CHECKIDAY_BACKUP_HOLIDAYS = [
  { title: "National Read a Book Day", description: "Encouraging people to pause and spend the day reading a book of their choosing.", origin: CURATED_ORIGINS['national read a book day'], summary: "National Read a Book Day encourages people to pause from their busy lives to spend the day reading a book of their choosing.", link: "https://www.checkiday.com" },
  { title: "Barbie Doll Day", description: "Marks the anniversary of the day that the Barbie doll first went on sale in 1959.", origin: CURATED_ORIGINS['barbie doll day'], summary: "Barbie Doll Day marks the anniversary of the day that the Barbie doll first went on sale in 1959, created by Ruth Handler.", link: "https://www.checkiday.com" },
  { title: "Fight Procrastination Day", description: "Take charge of your day and tackle tasks with renewed energy.", origin: CURATED_ORIGINS['fight procrastination day'], summary: "Although procrastination may take place on most days, today is about getting tasks done at home, in the office, or at school.", link: "https://www.checkiday.com" },
  { title: "National Coffee Ice Cream Day", description: "Blends two great foods into one delicious creamy dessert.", origin: CURATED_ORIGINS['national coffee ice cream day'], summary: "National Coffee Ice Cream Day is a day that blends two great treats into one: ice cream and rich aromatic coffee.", link: "https://www.checkiday.com" },
  { title: "Great Egg Toss Day", description: "Celebrating the fun outdoor partner game and lawn contest.", origin: CURATED_ORIGINS['great egg toss day'], summary: "Great Egg Toss Day celebrates the sport of egg tossing, a classic lawn challenge played at picnics and fairs.", link: "https://www.checkiday.com" },
  { title: "Pet Rock Day", description: "Celebrating Gary Dahl's humorous, zero-maintenance 1975 pet fad.", origin: CURATED_ORIGINS['pet rock day'], summary: "In 1975, Gary Dahl created the pet rock as the perfect low-work pet, inspiring millions of smiles worldwide.", link: "https://www.checkiday.com" }
];

async function enrichHolidaySummaries(items) {
  if (!items || items.length === 0) return items;

  await Promise.allSettled(items.map(async (item) => {
    const key = (item.title || '').toLowerCase().trim();
    if (CURATED_ORIGINS[key]) {
      item.origin = CURATED_ORIGINS[key];
    }

    if (!item.link || !item.link.startsWith('http') || item.link === 'https://www.checkiday.com') {
      item.summary = item.description;
      if (!item.origin) item.origin = item.description;
      return;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const pageRes = await fetch(item.link, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'WeatherFriendsConsole/1.3 (DailyHolidayFeed)'
        }
      });
      clearTimeout(timeoutId);

      if (pageRes.ok) {
        const html = await pageRes.text();
        let desc = '';

        // 1. Prioritize JSON-LD structured data (often has full clean text)
        const jsonLdMatch = html.match(/<script type=["\x27]application\/ld\+json["\x27]>([\s\S]*?)<\/script>/i);
        if (jsonLdMatch) {
          try {
            const data = JSON.parse(jsonLdMatch[1]);
            if (data && data.description) {
              desc = String(data.description);
            }
          } catch (e) {}
        }

        // 2. Fallback to OpenGraph description
        if (!desc) {
          const ogMatch = html.match(/<meta[^>]*property=["\x27]og:description["\x27][^>]*content=["\x27]([^"\x27]+)["\x27]/i);
          if (ogMatch) {
            desc = ogMatch[1];
          }
        }

        if (desc) {
          const clean = desc
            .replace(/&#039;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/^[“"']+|[”"']+$/g, '')
            .replace(/\s+/g, ' ')
            .trim();

          // Extract first 1-2 complete sentences
          const rawSentences = clean.match(/[^.!?]+[.!?]+(\s|$)/g) || [];
          const validSentences = rawSentences
            .map(s => s.trim())
            .filter(s => s.length > 20 && !s.endsWith('…') && !s.endsWith('...'));

          if (validSentences.length > 0) {
            item.primarySummary = validSentences[0];
            item.summary = validSentences.slice(0, 2).join(' ').trim();
          } else {
            const noEllipsis = clean.replace(/[…\.]{2,}.*$/, '').trim();
            item.primarySummary = noEllipsis || clean;
            item.summary = noEllipsis || clean;
          }
        }
      }
    } catch (err) {
      // Graceful fallback to default description
    }

    if (!item.origin) {
      item.origin = item.primarySummary || item.description || `Today we celebrate ${item.title}!`;
    }
    if (!item.primarySummary) {
      item.primarySummary = item.origin;
    }
    if (!item.summary) {
      item.summary = item.primarySummary;
    }
  }));

  return items;
}

const FOOD_REGEX = /\b(food|foods|dish|dishes|cuisine|cooking|baking|drink|drinks|beer|brew|ale|lager|wine|coffee|espresso|latte|cappuccino|tea|pizza|burger|burgers|cheeseburger|sandwich|sandwiches|steak|steaks|schnitzel|soup|salad|bread|cake|pie|pies|cookie|cookies|taco|tacos|pasta|noodle|noodles|cheese|ice cream|chocolate|chocolates|apple|banana|pancake|pancakes|waffle|waffles|bbq|barbecue|grill|donut|donuts|doughnut|doughnuts|pretzel|pretzels|rice|curry|sushi|seafood|fish|lobster|crab|bacon|sausage|egg|eggs|muffin|muffins|popcorn|cocktail|cocktails|smoothie|cider|whiskey|bourbon|rum|vodka|tequila|dessert|desserts|honey|pickle|pickles|potato|potatoes|nacho|nachos|burrito|burritos|avocado|guacamole|watermelon|peach|cherry|cherries|strawberry|strawberries|blueberry|blueberries)\b/i;
const EXCLUDE_FOOD_REGEX = /\b(awareness|disorder|syndrome|disease|prevention|abuse|cancer|teddy|bear)\b/i;

function filterHolidayList(list, excludeFood) {
  if (!excludeFood || !Array.isArray(list)) return list;
  const filtered = list.filter(it => {
    const fullText = `${it.title} ${it.description || ''} ${it.summary || ''}`;
    return !(FOOD_REGEX.test(fullText) && !EXCLUDE_FOOD_REGEX.test(it.title) && !EXCLUDE_FOOD_REGEX.test(fullText));
  });
  return (filtered.length > 0) ? filtered : list;
}

app.get('/api/checkiday', async (req, res) => {
  // Always prevent smart TV and browser disk caching on API data
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const now = new Date();
  const tz = req.query.tz || 'America/New_York';
  let dateKey;
  try {
    dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  } catch (e) {
    dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  }

  // Client can explicitly supply its current calendar date
  if (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
    dateKey = req.query.date;
  }

  const force = req.query.refresh === '1';
  const excludeFood = req.query.excludeFood === '1';

  // Automatically reset cache if calendar date changed from previous day
  if (checkidayCache.dateKey && checkidayCache.dateKey !== dateKey) {
    console.log(`[Checkiday Server] Date rolled over from ${checkidayCache.dateKey} to ${dateKey}. Purging stale cache.`);
    checkidayCache = { dateKey, fetchedAt: 0, holidays: [] };
  }

  // Return cached result if same calendar day and fetched within 60 minutes
  if (!force && checkidayCache.dateKey === dateKey && checkidayCache.holidays.length > 0 && (Date.now() - checkidayCache.fetchedAt < 60 * 60 * 1000)) {
    const holidays = filterHolidayList(checkidayCache.holidays, excludeFood);
    return res.json({
      success: true,
      date: checkidayCache.dateKey,
      cached: true,
      count: holidays.length,
      holidays,
      serverTime: Date.now()
    });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const feedRes = await fetch('https://api.checkiday.com/rss', {
      signal: controller.signal,
      headers: {
        'User-Agent': 'WeatherFriendsConsole/1.3 (DailyHolidayFeed)'
      }
    });
    clearTimeout(timeoutId);

    if (feedRes.ok) {
      const xmlText = await feedRes.text();
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
      let match;

      const cleanStr = (s) => (s || '')
        .replace(/<!\[CDATA\[/g, '')
        .replace(/\]\]>/g, '')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();

      while ((match = itemRegex.exec(xmlText)) !== null) {
        const itemXml = match[1];
        const titleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
        const linkMatch = itemXml.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
        const descMatch = itemXml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
        const pubDateMatch = itemXml.match(/<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i);

        const title = cleanStr(titleMatch ? titleMatch[1] : '');
        const link = cleanStr(linkMatch ? linkMatch[1] : '');
        let description = cleanStr(descMatch ? descMatch[1] : '');
        if (!description || description.toLowerCase() === `today is ${title.toLowerCase()}!`) {
          description = `Celebrating ${title} today!`;
        }

        if (title) {
          items.push({
            title,
            description,
            link: link || 'https://www.checkiday.com',
            pubDate: cleanStr(pubDateMatch ? pubDateMatch[1] : '')
          });
        }
      }

      if (items.length > 0) {
        // Fast enrichment with 2500ms race so RSS items are NEVER discarded
        try {
          await Promise.race([
            enrichHolidaySummaries(items),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Enrichment timeout')), 2500))
          ]);
        } catch (enrichErr) {
          console.warn('[Checkiday] Enrichment partial or timed out, using parsed items:', enrichErr.message);
        }

        // Fill in any missing origin or summary
        items.forEach(it => {
          if (!it.origin) it.origin = it.primarySummary || it.description || `Celebrating ${it.title} today!`;
          if (!it.primarySummary) it.primarySummary = it.origin;
          if (!it.summary) it.summary = it.primarySummary;
        });

        checkidayCache = {
          dateKey,
          fetchedAt: Date.now(),
          holidays: items
        };

        const holidays = filterHolidayList(items, excludeFood);
        return res.json({
          success: true,
          date: dateKey,
          count: holidays.length,
          holidays,
          serverTime: Date.now()
        });
      }
    }
  } catch (err) {
    console.error('Checkiday feed error:', err.message);
  }

  // If server cache exists for today, prefer that over static backup
  const fallbackList = filterHolidayList((checkidayCache.dateKey === dateKey && checkidayCache.holidays.length > 0)
    ? checkidayCache.holidays
    : CHECKIDAY_BACKUP_HOLIDAYS, excludeFood);

  res.json({
    success: true,
    date: dateKey,
    count: fallbackList.length,
    holidays: fallbackList,
    fallback: true,
    serverTime: Date.now()
  });
});

/* ===============================================================
   FOOD & DRINK HOLIDAYS API ROUTE (/api/food-holidays)
   - Powered by comprehensive 365-day culinary registry (Julee Ho Food Marketing Directory)
   - Live filters and merges culinary celebrations from Checkiday
   - Enriches with appetizing food trivia, emojis, and origin lore
   - Provides guaranteed 365-day fallback coverage for every calendar day
=============================================================== */
let foodHolidaysCache = { dateKey: '', fetchedAt: 0, holidays: [] };

// 365-Day Julee Ho Culinary Registry loader & live updater
let JULEE_HO_365_CALENDAR = {};
try {
  const calPath = path.join(__dirname, 'food-calendar-365.json');
  if (fs.existsSync(calPath)) {
    JULEE_HO_365_CALENDAR = JSON.parse(fs.readFileSync(calPath, 'utf8'));
    console.log(`[Food Calendar] Loaded 365-day registry with ${Object.keys(JULEE_HO_365_CALENDAR).length} days`);
  }
} catch (err) {
  console.warn('[Food Calendar] Could not load local food-calendar-365.json:', err.message);
}

// Background sync function to refresh Julee Ho 365-day food list
async function syncJuleeHoFoodCalendar() {
  try {
    const res = await fetch('https://juleeho.com/food-marketing-blog/food-holidays-the-most-comprehensive-365-day-list', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!res.ok) return;
    let html = await res.text();
    html = html.replace(/&nbsp;/g, ' ');

    const regex = /<p[^>]*style="white-space:pre-wrap;"[^>]*>([^<]+)<\/p>/gi;
    let match;
    const items = [];
    while ((match = regex.exec(html)) !== null) {
      items.push(match[1].trim());
    }

    const monthMap = {
      january: '01', february: '02', march: '03', april: '04',
      may: '05', june: '06', july: '07', august: '08',
      september: '09', october: '10', november: '11', december: '12'
    };

    const newCalendar = {};
    for (const text of items) {
      const clean = text.replace(/\s+/g, ' ').trim();
      if (!clean || clean.length < 5) continue;
      if (clean.startsWith('If you work in the food space') || clean.includes('Food Holidays list')) continue;

      const m1 = clean.match(/^(.*?)\s*[-–—:]*\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s*[-–—:]*\s*(\d{1,2})\b/i);
      const m2 = clean.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s*[-–—:]*\s*(\d{1,2})\s*[-–—:]\s*(.*?)$/i);
      
      if (m1 && m1[1].trim().length > 2) {
        let holiday = m1[1].trim().replace(/^[–—\-:\s]+|[–—\-:\s]+$/g, '').trim();
        const month = monthMap[m1[2].toLowerCase()];
        const day = m1[3].padStart(2, '0');
        const key = `${month}-${day}`;
        if (!newCalendar[key]) newCalendar[key] = [];
        if (!newCalendar[key].includes(holiday)) newCalendar[key].push(holiday);
      } else if (m2 && m2[3].trim().length > 2) {
        let holiday = m2[3].trim().replace(/^[–—\-:\s]+|[–—\-:\s]+$/g, '').trim();
        const month = monthMap[m2[1].toLowerCase()];
        const day = m2[2].padStart(2, '0');
        const key = `${month}-${day}`;
        if (!newCalendar[key]) newCalendar[key] = [];
        if (!newCalendar[key].includes(holiday)) newCalendar[key].push(holiday);
      }
    }

    if (!newCalendar['02-29']) {
      newCalendar['02-29'] = ['National Surf and Turf Day (Leap Year Celebration)'];
    }

    if (Object.keys(newCalendar).length >= 300) {
      JULEE_HO_365_CALENDAR = newCalendar;
      fs.writeFileSync(path.join(__dirname, 'food-calendar-365.json'), JSON.stringify(newCalendar, null, 2), 'utf8');
      console.log(`[Food Calendar] Successfully synced 365-day registry (${Object.keys(newCalendar).length} days) from Julee Ho blog`);
    }
  } catch (e) {
    console.warn('[Food Calendar] Background sync error:', e.message);
  }
}

// Automatically sync if calendar has low count
if (Object.keys(JULEE_HO_365_CALENDAR).length < 300) {
  syncJuleeHoFoodCalendar();
}

function getFoodEmoji(title = '') {
  const t = title.toLowerCase();
  if (/chicken|poultry|turkey/i.test(t)) return '🍗';
  if (/steak|beef|brisket|ribeye|prime rib/i.test(t)) return '🥩';
  if (/barbecue|sparerib|ribs|bbq|pork/i.test(t)) return '🍖';
  if (/bacon/i.test(t)) return '🥓';
  if (/hot dog|sausage|bratwurst/i.test(t)) return '🌭';
  if (/burger|cheeseburger/i.test(t)) return '🍔';
  if (/pizza/i.test(t)) return '🍕';
  if (/sandwich|hoagie|sub|panini|blt|grilled cheese/i.test(t)) return '🥪';
  if (/taco|burrito|enchilada|chipotle|tamale|nacho/i.test(t)) return '🌮';
  if (/pasta|spaghetti|noodle|lasagna|ravioli|macaroni|fettuccine/i.test(t)) return '🍝';
  if (/sushi|sashimi/i.test(t)) return '🍣';
  if (/fish|salmon|tuna|seafood|clam|oyster|shrimp|lobster|crab/i.test(t)) return '🦞';
  if (/soup|stew|chowder|chili|broth/i.test(t)) return '🍲';
  if (/salad|greens/i.test(t)) return '🥗';
  if (/bread|toast|bagel|croissant|biscuit|schnitzel|pretzel/i.test(t)) return '🥖';
  if (/cheese|fondue|gouda/i.test(t)) return '🧀';
  if (/pancake|crepe/i.test(t)) return '🥞';
  if (/waffle/i.test(t)) return '🧇';
  if (/egg|omelet|frittata/i.test(t)) return '🍳';
  if (/curry|samosa|street food/i.test(t)) return '🥟';
  if (/ice cream|sundae|gelato|sorbet|popsicle/i.test(t)) return '🍦';
  if (/chocolate|fudge|truffle|cocoa/i.test(t)) return '🍫';
  if (/cake|cheesecake|cupcake/i.test(t)) return '🍰';
  if (/pie|tart|cobbler/i.test(t)) return '🥧';
  if (/cookie|biscuit|shortbread/i.test(t)) return '🍪';
  if (/donut|doughnut/i.test(t)) return '🍩';
  if (/coffee|espresso|latte|cappuccino|mocha/i.test(t)) return '☕';
  if (/tea|chai|matcha/i.test(t)) return '🍵';
  if (/beer|brew|ale|lager|stout|oktoberfest/i.test(t)) return '🍺';
  if (/wine|champagne|prosecco|sangria/i.test(t)) return '🍷';
  if (/cocktail|margarita|martini|bloody mary|mimosa|mojito/i.test(t)) return '🍸';
  if (/rum|whiskey|bourbon|vodka|tequila|gin|brandy|liqueur/i.test(t)) return '🥃';
  if (/cherry|cherries/i.test(t)) return '🍒';
  if (/strawberry|strawberries/i.test(t)) return '🍓';
  if (/apple|cider/i.test(t)) return '🍎';
  if (/banana/i.test(t)) return '🍌';
  if (/watermelon|melon/i.test(t)) return '🍉';
  if (/grape/i.test(t)) return '🍇';
  if (/lemon|lime|citrus/i.test(t)) return '🍋';
  if (/peach/i.test(t)) return '🍑';
  if (/potato|fries|tater/i.test(t)) return '🥔';
  if (/popcorn/i.test(t)) return '🍿';
  return '🍽️';
}

function getAppetizingDescription(title = '') {
  const t = title.toLowerCase();
  if (/tamale/i.test(t)) return 'Honoring traditional masa packets wrapped in corn husks, steamed tender with savory meats, chilies, and holiday love.';
  if (/pumpkin pie/i.test(t)) return 'Celebrating velvety spiced pumpkin custard baked in flaky pastry crust, topped with generous dollops of whipped cream.';
  if (/bloody mary/i.test(t)) return 'A classic brunch cocktail featuring zesty seasoned tomato juice, horseradish, Worcestershire, celery, and savory garnishes.';
  if (/irish food/i.test(t)) return 'Celebrating hearty heritage comfort dishes: traditional soda bread, shepherd’s pie, colcannon, and rich beef stew.';
  if (/barbecued sparerib|spareribs/i.test(t)) return 'Honoring tender, smoky slow-cooked pork spareribs glazed in caramelized sweet and tangy barbecue sauces.';
  if (/grilled cheese/i.test(t)) return 'Celebrating golden griddled comfort food perfection with gooey melted cheese toasted between crisp slices of artisan bread.';
  if (/sushi/i.test(t)) return 'Honoring Japanese culinary artistry: delicate cuts of fresh fish, seasoned vinegared rice, and handcrafted nori rolls.';
  if (/cherry tart/i.test(t)) return 'Celebrating sweet and tart ruby cherries baked into buttery pastry shells with light glaze and almond essence.';
  if (/caramel apple/i.test(t)) return 'Crisp autumn orchard apples dipped in warm, buttery caramel and rolled in chopped nuts or sea salt.';
  if (/cake/i.test(t)) return 'Honoring multi-layered, frosted confectionery masterpieces that mark celebrations, birthdays, and sweet moments.';
  if (/i love food/i.test(t)) return 'An unapologetic celebration of worldwide flavors, home-cooked feasts, comfort bites, and culinary craftsmanship.';
  if (/bratwurst/i.test(t)) return 'Celebrating savory German sausages simmered in beer and grilled over glowing charcoal with spicy mustard and sauerkraut.';
  if (/rum/i.test(t)) return 'Celebrating sugarcane spirits distilled into rich dark, spiced, and golden rums across tropical islands.';
  if (/picnic/i.test(t)) return 'Celebrating outdoor feasts in the sunshine with fresh sandwiches, chilled drinks, and good friends.';
  if (/buffet/i.test(t)) return 'Celebrating all-you-can-eat spreads featuring endless culinary varieties from around the world.';
  if (/cream puff/i.test(t)) return 'Delicate, airy choux pastry shells filled with velvety sweet pastry cream and dusted with powdered sugar.';
  return `A delicious celebration honoring ${title.replace(/^[\p{Emoji}\u200d\s]+/u, '')} with favorite recipes, tasty pairings, and culinary tradition.`;
}

const CURATED_FOOD_CALENDAR = {
  '09-01': [
    { title: '🥖 National French Toast Day', description: 'Celebrating thick slices of egg-battered brioche crisped golden on the griddle with warm maple syrup.' },
    { title: '🥟 World Samosa Day', description: 'Dedicated to the crispy, golden spiced potato and pea pastry beloved across global street food cultures.' }
  ],
  '09-02': [
    { title: '🫐 National Blueberry Popsicle Day', description: 'Cooling down summer afternoons with vibrant fresh blueberry juice frozen on wooden sticks.' }
  ],
  '09-03': [
    { title: '🥓 National Bacon Day', description: 'Honoring sizzling, hickory-smoked, crispy bacon slices paired with breakfasts, burgers, and maple glazes.' }
  ],
  '09-04': [
    { title: '🌰 National Macadamia Nut Day', description: 'Celebrating the buttery, rich, golden-roasted native Australian nuts famous in gourmet cookies and confections.' }
  ],
  '09-05': [
    { title: '🍕 National Cheese Pizza Day', description: 'Honoring the timeless perfection of bubbling mozzarella, rich seasoned tomato marinara, and crisp oven-fired crust.' }
  ],
  '09-06': [
    { title: '☕ National Coffee Ice Cream Day', description: 'Blends two of life\'s greatest treats: bold roasted espresso and velvety, churned sweet cream.' }
  ],
  '09-07': [
    { title: '🍺 National Beer Lover\'s Day', description: 'Celebrating craft breweries, time-honored brewing traditions, and crisp refreshing hops across the globe.' },
    { title: '🌰 National Acorn Squash Day', description: 'Welcoming autumn harvest tables with sweet, tender roasted acorn squash drizzled in brown sugar and butter.' }
  ],
  '09-08': [
    { title: '🥣 National Date Nut Bread Day', description: 'Celebrating the warm, spiced, sweet loaf studded with rich Medjool dates and crunchy toasted walnuts.' }
  ],
  '09-09': [
    { title: '🍗 National Grilled Chicken Day', description: 'Honoring juicy flame-grilled, citrus-herb marinated chicken cuts crisped over open coals with smoky barbecue glazes.' },
    { title: '🥩 National Steak au Poivre Day', description: 'Honoring the French bistro classic of prime tenderloin crusted in cracked black peppercorns and flamed with cognac cream.' },
    { title: '🥖 National Wiener Schnitzel Day', description: 'Austria\'s culinary crown jewel: tender cutlets coated in crisp golden breadcrumbs and finished with fresh lemon.' },
    { title: '🍲 National "I Love Food" Day', description: 'An unapologetic celebration of worldwide flavors, home-cooked feasts, comfort bites, and culinary craftsmanship.' },
    { title: '🥟 World Samosa & Street Food Celebration', description: 'Celebrating golden, crispy pastry triangles packed with spiced potatoes, peas, and fragrant herbs enjoyed worldwide.' },
    { title: '🍺 International Buy a Priest a Beer Day', description: 'A lighthearted tradition celebrating fellowship, neighborly cheer, and sharing a cold pint.' }
  ],
  '09-10': [
    { title: '📺 National TV Dinner Day', description: 'Celebrating Swanson\'s 1953 mid-century cultural revolution that brought convenient three-compartment hot trays to living rooms.' }
  ],
  '09-11': [
    { title: '🌶️ National Hot Cross Bun Day', description: 'Spiced sweet yeast buns packed with raisins, cinnamon, and marked with iconic icing crosses.' }
  ],
  '09-12': [
    { title: '🍫 National Chocolate Milkshake Day', description: 'Rich chocolate ganache or Dutch cocoa blended thick with vanilla ice cream and topped with whipped cream.' }
  ],
  '09-13': [
    { title: '🍫 International Chocolate Day', description: 'Honoring Milton Hershey\'s birthday and celebrating the ancient Mayan food of the gods enjoyed worldwide.' },
    { title: '🍪 National Peanut Butter Day', description: 'Celebrating creamy and crunchy roasted peanut butter in sandwiches, cookies, and spooned straight from the jar.' }
  ],
  '09-14': [
    { title: '🍩 National Cream-Filled Donut Day', description: 'Golden fried yeast rings injected with luscious Bavarian custard or sweet whipped marshmallow cream.' }
  ],
  '09-15': [
    { title: '🧀 National Double Cheeseburger Day', description: 'Two seared beef patties, two layers of gooey melted American cheddar, and classic griddle onions.' },
    { title: '🧀 National Linguine Day', description: 'Celebrating Italy\'s delicate ribbon pasta tossed in rich white clam sauce or fragrant Genovese pesto.' }
  ],
  '09-16': [
    { title: '🥑 National Guacamole Day', description: 'Creamy Hass avocados mashed fresh with lime juice, minced cilantro, diced red onion, and jalapeños.' }
  ],
  '09-17': [
    { title: '🥧 National Apple Dumpling Day', description: 'Whole crisp tart apples wrapped in flaky buttery pastry, baked until caramelised and bathed in cinnamon syrup.' }
  ],
  '09-18': [
    { title: '🍔 National Cheeseburger Day', description: 'The ultimate American diner classic: juicy flame-grilled patties, melted cheddar, pickles, and toasted brioche.' }
  ],
  '09-19': [
    { title: '🧈 National Butterscotch Pudding Day', description: 'Velvety cooked custard rich with browned butter, dark brown sugar, cream, and a pinch of sea salt.' }
  ],
  '09-20': [
    { title: '🍕 National Pepperoni Pizza Day', description: 'America\'s favorite slice: crisp cups of spiced cured pepperoni, melted whole-milk mozzarella, and charred crust.' }
  ],
  '09-21': [
    { title: '🍪 National Pecan Cookie Day', description: 'Buttery shortbread cookies packed with roasted Georgia pecans and rolled in confectioner\'s sugar.' }
  ],
  '09-22': [
    { title: '🍦 National White Chocolate Day', description: 'Silky cocoa butter, sweet milk solids, and bourbon vanilla crafted into decadent bars and truffles.' }
  ],
  '09-23': [
    { title: '🥧 Great American Pot Pie Day', description: 'Tender pulled chicken or beef simmered with garden vegetables in rich gravy under a golden puff pastry lid.' }
  ],
  '09-24': [
    { title: '🥞 National Cherries Jubilee Day', description: 'Dark pitted cherries flamed with Kirsch liqueur and ladled warm over rich scoops of vanilla bean ice cream.' }
  ],
  '09-25': [
    { title: '🦞 National Lobster Day', description: 'Sweet Atlantic Maine lobster tails steamed fresh, served with lemon wedges and hot drawn butter.' }
  ],
  '09-26': [
    { title: '🥞 National Pancake Day', description: 'Fluffy buttermilk flapjacks stacked high, melting sweet cream butter and drizzled with warm amber syrup.' }
  ],
  '09-27': [
    { title: '🥩 National Corned Beef Hash Day', description: 'Slow-cured beef diced with crispy griddled potatoes and caramelized onions, topped with sunny eggs.' }
  ],
  '09-28': [
    { title: '☕ National Drink Beer Day', description: 'Raising a frosty stein to centuries of master brewing craftsmanship, malt, and aromatic hops.' }
  ],
  '09-29': [
    { title: '☕ National Coffee Day', description: 'Celebrating the world\'s favorite energizing brew: fresh pour-overs, rich espressos, and morning roasts.' }
  ],
  '09-30': [
    { title: '🍷 National Mulled Wine Day', description: 'Red wine simmered warm with cinnamon sticks, whole cloves, star anise, and fresh orange peel.' }
  ]
};

app.get('/api/food-holidays', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const now = new Date();
  const tz = req.query.tz || 'America/New_York';
  let realTodayKey;
  try {
    realTodayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  } catch (e) {
    realTodayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  }
  let dateKey = realTodayKey;
  if (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
    dateKey = req.query.date;
  }

  const mmDd = dateKey.slice(5); // e.g. "09-09"
  const force = req.query.refresh === '1';

  if (!force && foodHolidaysCache.dateKey === dateKey && foodHolidaysCache.holidays.length > 0 && (Date.now() - foodHolidaysCache.fetchedAt < 60 * 60 * 1000)) {
    return res.json({
      success: true,
      date: foodHolidaysCache.dateKey,
      cached: true,
      count: foodHolidaysCache.holidays.length,
      holidays: foodHolidaysCache.holidays,
      serverTime: Date.now()
    });
  }

  const foodItems = [];

  // 1. Seed with curated culinary calendar for this date (rich descriptions & verified dishes)
  const curatedToday = CURATED_FOOD_CALENDAR[mmDd] || [];
  curatedToday.forEach(cItem => {
    foodItems.push({
      title: cItem.title,
      description: cItem.description,
      link: 'https://www.checkiday.com',
      source: 'Curated Culinary Registry'
    });
  });

  // 2. Supplement with Julee Ho 365-Day Culinary Registry for this date
  const juleeHoToday = JULEE_HO_365_CALENDAR[mmDd] || [];
  juleeHoToday.forEach(hName => {
    const cleanName = hName.replace(/^[\p{Emoji}\u200d\s]+/u, '').replace(/["“”'‘’]/g, '').toLowerCase().trim();
    const existing = foodItems.find(f => {
      const cleanF = f.title.replace(/^[\p{Emoji}\u200d\s]+/u, '').replace(/["“”'‘’]/g, '').toLowerCase().trim();
      return cleanF.includes(cleanName) || cleanName.includes(cleanF);
    });
    if (!existing) {
      const emoji = getFoodEmoji(hName);
      const title = /^[\p{Emoji}\u200d]+/u.test(hName) ? hName : `${emoji} ${hName}`;
      foodItems.push({
        title,
        description: getAppetizingDescription(hName),
        link: 'https://juleeho.com/food-marketing-blog/food-holidays-the-most-comprehensive-365-day-list',
        source: 'Julee Ho 365-Day Culinary Registry'
      });
    }
  });

  // 3. Discover and merge additional food celebrations from today's live Checkiday feed (only if querying today)
  if (dateKey === realTodayKey) {
    try {
      let checkidayItems = [];
      if (checkidayCache.dateKey === dateKey && checkidayCache.holidays.length > 0) {
        checkidayItems = checkidayCache.holidays;
      } else {
        const cRes = await fetch(`http://127.0.0.1:${PORT}/api/checkiday?date=${dateKey}&tz=${encodeURIComponent(tz)}`);
        if (cRes.ok) {
          const cData = await cRes.json();
          if (cData && Array.isArray(cData.holidays)) {
            checkidayItems = cData.holidays;
          }
        }
      }

      checkidayItems.forEach(item => {
        const fullText = `${item.title} ${item.description || ''} ${item.summary || ''}`;
        if (FOOD_REGEX.test(fullText) && !EXCLUDE_FOOD_REGEX.test(item.title) && !EXCLUDE_FOOD_REGEX.test(fullText)) {
          const cleanTitle = item.title.replace(/^[\p{Emoji}\u200d\s]+/u, '').replace(/["“”'‘’]/g, '').toLowerCase().trim();
          const existing = foodItems.find(f => {
            const cleanF = f.title.replace(/^[\p{Emoji}\u200d\s]+/u, '').replace(/["“”'‘’]/g, '').toLowerCase().trim();
            return cleanF.includes(cleanTitle) || cleanTitle.includes(cleanF);
          });

          if (existing) {
            if (item.link) existing.link = item.link;
          } else {
            let title = item.title;
            if (!/^[\p{Emoji}\u200d]+/u.test(title)) {
              const emoji = getFoodEmoji(title);
              title = `${emoji} ${title}`;
            }
            foodItems.push({
              title,
              description: item.summary || item.origin || item.description || getAppetizingDescription(item.title),
              link: item.link || 'https://www.checkiday.com',
              source: 'Checkiday Culinary'
            });
          }
        }
      });
    } catch (err) {
      console.warn('[Food Holidays] Checkiday extract failed:', err.message);
    }
  }

  // 3. If empty, provide gourmet fallback
  if (foodItems.length === 0) {
    foodItems.push(
      { title: '🍽️ World Food Discovery Day', description: 'Celebrating global comfort foods, heritage recipes, and savoring new culinary flavours.', link: 'https://www.checkiday.com' },
      { title: '☕ Morning Roast Appreciation Day', description: 'Honoring artisanal coffee roasters, espresso craftsmanship, and cozy morning rituals.', link: 'https://www.checkiday.com' }
    );
  }

  // 4. Culinary Ranking: iconic meals & hearty dishes lead first, broad food days next, beverage observances last
  function getFoodPriority(title = '') {
    const t = title.toLowerCase();
    // Iconic savory and sweet main dishes (Highest Priority = 1)
    if (/chicken|poultry|steak|beef|schnitzel|pizza|burger|cheeseburger|pasta|linguine|taco|dumpling|samosa|pie|pancake|waffle|bacon|lobster|pot pie|donut|curry|hash|guacamole|french toast|sandwich|hoagie/i.test(t)) {
      return 1;
    }
    // Celebratory culinary appreciation (Priority = 2)
    if (/i love food|food day|cooking|baking|culinary/i.test(t)) {
      return 2;
    }
    // Sweets, desserts, nuts, produce (Priority = 3)
    if (/chocolate|ice cream|cookie|pudding|bread|nut|fruit|squash|dates|popsicle/i.test(t)) {
      return 3;
    }
    // Beverages, beer, wine, cocktail, coffee, novelty observances (Priority = 4)
    if (/beer|priest|wine|cocktail|drink|alcohol|brew|coffee|espresso|cider/i.test(t)) {
      return 4;
    }
    return 2;
  }

  foodItems.sort((a, b) => getFoodPriority(a.title) - getFoodPriority(b.title));

  foodHolidaysCache = {
    dateKey,
    fetchedAt: Date.now(),
    holidays: foodItems
  };

  res.json({
    success: true,
    date: dateKey,
    count: foodItems.length,
    holidays: foodItems,
    serverTime: Date.now()
  });
});

/* ===============================================================
   THIS DAY IN RETRO TECH & SPACE API ROUTE (/api/tech-history)
   - Live ingests Marcel Brown's official "This Day in Tech History" RSS
   - Enriches with curated computing & space exploration milestones
   - Decodes entities, strips boilerplate, extracts vintage year
=============================================================== */
let techHistoryCache = { dateKey: '', fetchedAt: 0, items: [] };

const TECH_BACKUP_EVENTS = [
  { title: "The First Computer “Bug” (1945)", year: "1945", description: "Operators of the Harvard Mark II find a moth trapped in relay #70 in panel F. The bug is taped into their logbook with the note: 'First actual case of bug being found.' This coined the modern term 'debugging'.", primarySummary: "Operators of the Harvard Mark II find a moth trapped in relay #70 in panel F. The bug is taped into their logbook, coining the modern term 'debugging'.", source: "This Day in Tech History" },
  { title: "Remote Computing Pioneer (1940)", year: "1940", description: "Mathematician George Stibitz demonstrates the first remote operation of a computer using a Teletype terminal connected via standard telegraph lines to Bell Labs.", primarySummary: "Mathematician George Stibitz demonstrates the first remote operation of a computer using a Teletype terminal connected via standard telegraph lines to Bell Labs.", source: "Tech History Archives" },
  { title: "Space Shuttle Discovery STS-64 (1994)", year: "1994", description: "Space Shuttle Discovery launches on mission STS-64, performing the first untethered spacewalk in ten years to test the SAFER astronaut jetpack.", primarySummary: "Space Shuttle Discovery launches on mission STS-64, performing the first untethered spacewalk in ten years to test the SAFER astronaut jetpack.", source: "NASA Space History" },
  { title: "Space Shuttle Atlantis STS-115 (2006)", year: "2006", description: "Space Shuttle Atlantis launches to the International Space Station, delivering and installing the massive P3/P4 solar truss segment.", primarySummary: "Space Shuttle Atlantis launches to the International Space Station, delivering and installing the massive P3/P4 solar truss segment.", source: "NASA Space History" }
];

function cleanTechHistoryText(rawDesc, rawTitle) {
  if (!rawDesc) return { concise: rawTitle || '', full: rawTitle || '', year: '' };

  // 1. Split into paragraphs and pick the story paragraph (discard attribution footer paragraph)
  const paragraphs = String(rawDesc).split(/<\/p>/i);
  const contentParagraph = paragraphs.find(p => !/is original content of|This Day in Tech History/i.test(p)) || paragraphs[0] || '';

  // 2. Decode HTML entities and strip markup
  let clean = contentParagraph
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
    .replace(/&#8216;/g, "'").replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, '–').replace(/&#8212;/g, '—')
    .replace(/&#8230;/g, '...')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/is original content of This Day in Tech History\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 3. Extract year if description starts with "Month Day, Year"
  const yearMatch = clean.match(/^(?:[A-Za-z]+\s+\d{1,2},\s+)?(\d{4})\s+/);
  let year = yearMatch ? yearMatch[1] : '';
  if (yearMatch) {
    clean = clean.slice(yearMatch[0].length).trim();
  }

  // 4. Strip duplicate title or "[Title] is original content" lingering at end
  if (rawTitle) {
    const plainTitle = rawTitle.replace(/^["“”'‘’\s]+|["“”'‘’\s]+$/g, '').trim();
    clean = clean.replace(new RegExp('(?:\\[\\.{3}\\]|\\.{3}|\\…)?\\s*["“”\'‘’]?' + plainTitle.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '["“”\'‘’]?\\s*$', 'i'), '').trim();
  }

  const wasTruncated = /\.{3,}$/.test(clean);
  clean = clean.replace(/\s*\.{3,}\s*$/, '').trim();

  // 5. Split into sentences with protection for common abbreviations
  const protectedText = clean
    .replace(/\b(Inc|Corp|Co|Ltd|Gov|Dept|Gen|Col|Maj|Capt|Lt|Sgt|St|Mr|Mrs|Ms|Dr|Prof|Rev|vs|approx|no)\./gi, '$1{{DOT}}')
    .replace(/\b(U\.S|e\.g|i\.e)\./gi, '$1{{DOT}}')
    .replace(/(\d)\.(\d)/g, '$1{{DECIMAL}}$2');

  const rawSentences = protectedText.match(/[^.!?]+(?:[.!?]+|$)/g) || [protectedText];
  const sentences = rawSentences.map(p => p
    .replace(/\{\{DOT\}\}/g, '.')
    .replace(/\{\{DECIMAL\}\}/g, '.')
    .trim()
  ).filter(Boolean);

  // If source feed cut off with an incomplete sentence, drop the trailing fragment
  if (wasTruncated && sentences.length > 1) {
    const last = sentences[sentences.length - 1];
    if (last.length < 45 || /^(?:but|and|or|however|so|yet|because|this was|which was|that was)\b/i.test(last) || /\b(?:the|a|an|in|on|at|to|of|for|with|by|from|about|into|through|during|before|after|above|below|is|was|are|were|be|been|being)\.?$/i.test(last)) {
      sentences.pop();
    }
  }

  let full = sentences.join(' ').trim();
  if (full && !/[.!?]$/.test(full)) full += '.';

  let concise = '';
  for (const s of sentences) {
    const cleanS = /[.!?]$/.test(s) ? s : s + '.';
    if (!concise) {
      concise = cleanS;
    } else if ((concise + ' ' + cleanS).length <= 180) {
      concise += ' ' + cleanS;
    } else {
      break;
    }
  }
  if (!concise && sentences.length > 0) {
    concise = sentences[0];
  }
  if (concise && !/[.!?]$/.test(concise)) concise += '.';

  return {
    year,
    concise: concise || full,
    full: full || concise
  };
}

app.get('/api/tech-history', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const now = new Date();
  const tz = req.query.tz || 'America/New_York';
  let dateKey;
  try {
    dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  } catch (e) {
    dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  }
  if (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
    dateKey = req.query.date;
  }

  const parts = dateKey.split('-');
  const mm = parts[1] || '09';
  const dd = parts[2] || '09';
  const force = req.query.refresh === '1';

  if (!force && techHistoryCache.dateKey === dateKey && techHistoryCache.items.length > 0 && (Date.now() - techHistoryCache.fetchedAt < 60 * 60 * 1000)) {
    return res.json({
      success: true,
      date: techHistoryCache.dateKey,
      cached: true,
      count: techHistoryCache.items.length,
      items: techHistoryCache.items,
      serverTime: Date.now()
    });
  }

  const results = [];

  // 1. Ingest Marcel Brown's official "This Day in Tech History" RSS
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4500);
    const feedRes = await fetch('https://feedpress.me/ThisDayInTechHistory', {
      signal: controller.signal,
      headers: {
        'User-Agent': 'WeatherFriendsConsole/1.3 (TechHistoryFeed)'
      }
    });
    clearTimeout(timeoutId);

    if (feedRes.ok) {
      const xml = await feedRes.text();
      const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
      let match;
      while ((match = itemRegex.exec(xml)) !== null && results.length < 4) {
        const itemXml = match[1];
        const titleM = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
        const descM = itemXml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
        const linkM = itemXml.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);

        const rawTitle = (titleM ? titleM[1] : '')
          .replace(/<!\[CDATA\[/g, '')
          .replace(/\]\]>/g, '')
          .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
          .replace(/&#8216;/g, "'").replace(/&#8217;/g, "'")
          .replace(/&amp;/g, '&')
          .trim();

        if (rawTitle) {
          const { year, concise, full } = cleanTechHistoryText(descM ? descM[1] : '', rawTitle);

          results.push({
            title: year ? `${rawTitle} (${year})` : rawTitle,
            year: year || 'Retro Tech',
            description: concise || rawTitle,
            summary: full || concise || rawTitle,
            primarySummary: concise || rawTitle,
            origin: concise || rawTitle,
            link: linkM ? linkM[1].trim() : 'https://thisdayintechhistory.com',
            source: 'This Day in Tech History'
          });
        }
      }
    }
  } catch (err) {
    console.warn('[Tech History] RSS ingestion notice:', err.message);
  }

  // 2. Enrich with Wikipedia "On This Day" Computing & Space Milestones
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    const wikiRes = await fetch(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'WeatherFriendsConsole/1.3 (OnThisDayTech)' }
    });
    clearTimeout(timeoutId);

    if (wikiRes.ok) {
      const wikiData = await wikiRes.json();
      if (wikiData && Array.isArray(wikiData.events)) {
        const techFilter = /(computer|computing|software|hardware|space|nasa|satellite|apollo|bug|robot|video game|arcade|internet|atari|nintendo|apple|ibm|transistor|radio|telescope|astronomy|physics|spacewalk|shuttle|cosmonaut|astronaut|microprocessor|semiconductor|laser)/i;
        const matches = wikiData.events.filter(e => techFilter.test(e.text));
        matches.slice(0, 5).forEach(ev => {
          const rawText = (ev.text || '').replace(/<[^>]*>/g, '').trim();
          if (/drone/i.test(rawText)) return; // filter modern military drones

          let label = `Milestone of ${ev.year}`;
          if (/space shuttle/i.test(rawText)) label = 'Space Shuttle Mission';
          else if (/satellite/i.test(rawText)) label = 'Orbital Satellite Launch';
          else if (/computer/i.test(rawText)) label = 'Computing Pioneer';
          else if (/broadcast|radio/i.test(rawText)) label = 'Broadcasting Milestone';
          else if (/telescope|astronomy/i.test(rawText)) label = 'Cosmic Observation';

          const { concise, full } = cleanTechHistoryText(rawText, label);

          results.push({
            title: `${label} (${ev.year})`,
            year: String(ev.year),
            description: concise || rawText,
            summary: full || rawText,
            primarySummary: concise || rawText,
            origin: concise || rawText,
            link: (ev.pages && ev.pages[0] && ev.pages[0].content_urls && ev.pages[0].content_urls.desktop && ev.pages[0].content_urls.desktop.page) || 'https://en.wikipedia.org',
            source: 'Tech History Archives'
          });
        });
      }
    }
  } catch (err) {
    console.warn('[Tech History] Wikipedia API notice:', err.message);
  }

  const finalItems = results.length > 0 ? results : TECH_BACKUP_EVENTS;

  techHistoryCache = {
    dateKey,
    fetchedAt: Date.now(),
    items: finalItems
  };

  res.json({
    success: true,
    date: dateKey,
    count: finalItems.length,
    items: finalItems,
    fallback: results.length === 0,
    serverTime: Date.now()
  });
});

// Fallback to index.html for any other route
app.get('*', serveIndexHtml);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
