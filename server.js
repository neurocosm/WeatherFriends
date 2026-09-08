import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Read current App Build Version from version.json (stamped in US Eastern Time EDT/EST)
function getAppVersion() {
  try {
    const versionFilePath = path.join(__dirname, 'version.json');
    if (fs.existsSync(versionFilePath)) {
      const data = JSON.parse(fs.readFileSync(versionFilePath, 'utf8'));
      if (data && data.version) return data.version;
    }
  } catch (e) {}
  return 'v1.090426.2243';
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

// Search location by City Name or ZIP Code (US, Canada, Global)
app.get('/api/search-location', async (req, res) => {
  const query = req.query.q?.trim();
  if (!query) return res.status(400).json({ results: [] });

  try {
    // If it looks like a 5-digit US zip code
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
                country: 'USA'
              }]
            });
          }
        }
      } catch (e) {
        // fallback to open-meteo
      }
    }

    // Open-Meteo Geocoding
    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=en&format=json`);
    if (geoRes.ok) {
      const gd = await geoRes.json();
      if (gd.results && gd.results.length > 0) {
        const list = gd.results.map(r => ({
          name: `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}${r.country_code ? ' (' + r.country_code + ')' : ''}`,
          lat: r.latitude,
          lon: r.longitude,
          country: r.country
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

  // Automatically reset cache if calendar date changed from previous day
  if (checkidayCache.dateKey && checkidayCache.dateKey !== dateKey) {
    console.log(`[Checkiday Server] Date rolled over from ${checkidayCache.dateKey} to ${dateKey}. Purging stale cache.`);
    checkidayCache = { dateKey, fetchedAt: 0, holidays: [] };
  }

  // Return cached result if same calendar day and fetched within 60 minutes
  if (!force && checkidayCache.dateKey === dateKey && checkidayCache.holidays.length > 0 && (Date.now() - checkidayCache.fetchedAt < 60 * 60 * 1000)) {
    return res.json({
      success: true,
      date: checkidayCache.dateKey,
      cached: true,
      count: checkidayCache.holidays.length,
      holidays: checkidayCache.holidays,
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

        return res.json({
          success: true,
          date: dateKey,
          count: items.length,
          holidays: items,
          serverTime: Date.now()
        });
      }
    }
  } catch (err) {
    console.error('Checkiday feed error:', err.message);
  }

  // If server cache exists for today, prefer that over static backup
  const fallbackList = (checkidayCache.dateKey === dateKey && checkidayCache.holidays.length > 0)
    ? checkidayCache.holidays
    : CHECKIDAY_BACKUP_HOLIDAYS;

  res.json({
    success: true,
    date: dateKey,
    count: fallbackList.length,
    holidays: fallbackList,
    fallback: true,
    serverTime: Date.now()
  });
});

// Fallback to index.html for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
