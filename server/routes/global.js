// /api/global — PUBLIC global configuration the apps need before anything else: the supported countries (with their
// currency, symbol and timezones), so no country list or currency rule is ever hardcoded in the frontend.
const express = require('express');
const router = express.Router();
const globalConfig = require('../services/globalConfig');

router.get('/countries', async (req, res) => {
  try { res.json({ success: true, countries: await globalConfig.listCountries({ onlyEnabled: true }) }); }
  catch (e) { res.status(500).json({ success: false, error: 'Could not load countries' }); }
});
router.get('/policy', async (req, res) => {
  try { res.json({ success: true, policy: await globalConfig.getActivePolicy() }); }
  catch (e) { res.status(500).json({ success: false, error: 'Could not load the policy' }); }
});

module.exports = router;
