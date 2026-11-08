const axios = require('axios');
require('dotenv').config();

/**
 * Searches for venues and places by text query.
 * Supports Google Places API when GOOGLE_MAPS_API_KEY is configured,
 * with automatic fallback to OpenStreetMap Nominatim and Photon.
 *
 * @param {string} query - The search term (e.g., "FitBuddy Turf Chennai")
 * @param {object} options - Optional bounds/country filters
 * @returns {Promise<Array>} List of standardized place objects
 */
async function searchVenues(query, options = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery || cleanQuery.length < 2) return [];

  const googleApiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;

  if (googleApiKey) {
    try {
      const googleResults = await searchGooglePlaces(cleanQuery, googleApiKey);
      if (googleResults && googleResults.length > 0) {
        return googleResults;
      }
    } catch (gErr) {
      console.warn('⚠️ Google Places API search failed, falling back to OSM:', gErr.message);
    }
  }

  // Fallback to Photon / OSM Nominatim
  try {
    const osmResults = await searchPhotonAndOsm(cleanQuery);
    if (osmResults && osmResults.length > 0) {
      return osmResults;
    }
  } catch (osmErr) {
    console.warn('⚠️ OSM search failed:', osmErr.message);
  }

  return [];
}

async function searchGooglePlaces(query, apiKey) {
  const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
  const response = await axios.get(url, {
    params: {
      query,
      key: apiKey,
      language: 'en'
    },
    timeout: 7000
  });

  const status = response.data?.status;
  if (status && status !== 'OK' && status !== 'ZERO_RESULTS') {
    throw new Error(`Google Places ${status}: ${response.data?.error_message || ''}`);
  }

  const results = response.data?.results || [];
  return results.slice(0, 10).map((item) => {
    const lat = item.geometry?.location?.lat;
    const lng = item.geometry?.location?.lng;
    return {
      place_id: item.place_id || `google_${item.id || Math.random().toString(36).slice(2)}`,
      name: item.name || query,
      formatted_address: item.formatted_address || item.vicinity || '',
      latitude: Number(lat),
      longitude: Number(lng),
      city: extractCityFromGoogle(item),
      state: '',
      country: 'IN',
      postal_code: '',
      provider: 'google'
    };
  });
}

function extractCityFromGoogle(item) {
  const parts = String(item.formatted_address || '').split(',').map(s => s.trim());
  if (parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return '';
}

async function searchPhotonAndOsm(query) {
  // 1. Try Nominatim directly
  try {
    const nominatimUrl = 'https://nominatim.openstreetmap.org/search';
    const res = await axios.get(nominatimUrl, {
      params: {
        q: query,
        format: 'json',
        addressdetails: 1,
        limit: 10
      },
      headers: {
        'User-Agent': 'BookMyArenaApp/1.0 (admin@bookmyarena.in)'
      },
      timeout: 10000
    });

    const items = res.data || [];
    if (items.length > 0) {
      return items.map((item) => {
        const addr = item.address || {};
        const city = addr.city || addr.town || addr.village || addr.suburb || addr.county || '';
        const state = addr.state || '';
        const country = addr.country || '';
        const postalCode = addr.postcode || '';

        return {
          place_id: `osm_${item.osm_type || 'N'}_${item.osm_id}`,
          name: item.display_name.split(',')[0],
          formatted_address: item.display_name,
          latitude: parseFloat(item.lat),
          longitude: parseFloat(item.lon),
          city: city || item.display_name.split(',')[0],
          state,
          country: country || 'India',
          postal_code: postalCode,
          provider: 'nominatim'
        };
      }).filter(p => !isNaN(p.latitude) && !isNaN(p.longitude) && p.latitude !== 0 && p.longitude !== 0);
    }
  } catch (nomErr) {
    console.warn('Nominatim query failed, trying Photon:', nomErr.message);
  }

  // 2. Try Photon (fast OpenStreetMap geocoder)
  try {
    const photonUrl = 'https://photon.komoot.io/api/';
    const response = await axios.get(photonUrl, {
      params: {
        q: query,
        limit: 10,
        lang: 'en'
      },
      headers: {
        'User-Agent': 'BookMyArenaApp/1.0 (admin@bookmyarena.in)'
      },
      timeout: 10000
    });

    const features = response.data?.features || [];
    if (features.length > 0) {
      return features.map((f) => {
        const coords = f.geometry?.coordinates || [];
        const lng = coords[0];
        const lat = coords[1];
        const props = f.properties || {};

        const name = props.name || query;
        const street = [props.housenumber, props.street].filter(Boolean).join(' ');
        const city = props.city || props.town || props.district || props.county || '';
        const state = props.state || '';
        const country = props.country || '';
        const postalCode = props.postcode || '';

        const addressParts = [
          name !== street && street,
          props.district,
          city,
          state,
          postalCode,
          country
        ].filter(Boolean);

        const formattedAddress = addressParts.join(', ') || name;

        return {
          place_id: String(props.osm_id ? `osm_${props.osm_type || 'N'}_${props.osm_id}` : `loc_${Math.random().toString(36).slice(2)}`),
          name,
          formatted_address: formattedAddress,
          latitude: Number(lat),
          longitude: Number(lng),
          city: city || props.name || '',
          state,
          country: country || 'India',
          postal_code: postalCode,
          provider: 'photon'
        };
      }).filter(p => !isNaN(p.latitude) && !isNaN(p.longitude) && p.latitude !== 0 && p.longitude !== 0);
    }
  } catch (err) {
    console.warn('Photon query failed:', err.message);
  }

  return [];
}

module.exports = {
  searchVenues
};
