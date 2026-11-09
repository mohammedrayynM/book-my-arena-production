const pool = require('./config/db');

async function testAds() {
  try {
    console.log('--- TESTING ADS SYSTEM ---');

    // Insert sample ads if none exist
    const [existing] = await pool.query('SELECT COUNT(*) as count FROM advertisements');
    console.log('Current ad count in database:', existing[0].count);

    const testAdsData = [
      {
        title: 'Weekend Sports Carnival - 30% Off',
        description: 'Book any turf this weekend and enjoy 30% flat discount on all evening slots.',
        image_url: 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=1200&q=80',
        sponsor_name: 'BookArena Rewards',
        link_url: '/turfs',
        placement: 'HOME_BANNER',
        priority: 10,
        is_active: 1
      },
      {
        title: 'Join the Summer Cricket Premier League',
        description: 'Compete for ₹50,000 cash prizes and trophies in the biggest regional tournament.',
        image_url: 'https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?w=1200&q=80',
        sponsor_name: 'Star Sports India',
        link_url: '/tournaments',
        placement: 'ENTRY_AD',
        priority: 5,
        is_active: 1
      },
      {
        title: 'Tournament Arena Championship 2026',
        description: 'Live match streaming and instant scoreboard updates for all registered teams.',
        image_url: 'https://images.unsplash.com/photo-1531415074968-036ba1b575da?w=1200&q=80',
        sponsor_name: 'Arena Pro',
        link_url: '/tournaments',
        placement: 'TOURNAMENT_AD',
        priority: 8,
        is_active: 1
      }
    ];

    for (const ad of testAdsData) {
      // Check if already inserted
      const [check] = await pool.query('SELECT id FROM advertisements WHERE title = ? AND placement = ?', [ad.title, ad.placement]);
      if (check.length === 0) {
        await pool.query(
          `INSERT INTO advertisements (title, description, image_url, sponsor_name, link_url, placement, priority, is_active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [ad.title, ad.description, ad.image_url, ad.sponsor_name, ad.link_url, ad.placement, ad.priority, ad.is_active]
        );
        console.log(`✅ Inserted test ad for placement [${ad.placement}]: "${ad.title}"`);
      } else {
        console.log(`ℹ️ Test ad already exists for [${ad.placement}]: ID #${check[0].id}`);
      }
    }

    // Now query placement filtering
    const placementsToTest = ['HOME_BANNER', 'ENTRY_AD', 'TOURNAMENT_AD'];
    for (const placement of placementsToTest) {
      const [ads] = await pool.query(
        'SELECT id, title, placement, priority, is_active FROM advertisements WHERE placement = ? AND is_active = 1',
        [placement]
      );
      console.log(`📍 Query placement [${placement}] => Found ${ads.length} active ads.`);
    }

    console.log('--- ALL ADS TESTS PASSED SUCCESSFULY ---');
    process.exit(0);
  } catch (err) {
    console.error('❌ Ads Test Error:', err);
    process.exit(1);
  }
}

testAds();
