import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Serve static files from the root directory
app.use(express.static(__dirname));

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

// Fallback to index.html for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
