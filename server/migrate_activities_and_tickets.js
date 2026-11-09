const pool = require('./config/db');

async function migrateActivitiesAndTickets() {
  console.log('🔄 Starting Activities & Multi-Ticket Database Migrations...');
  
  const isDupErr = (e) => /Duplicate column name|already exists/i.test(String(e?.message || ''));
  const isDupKeyErr = (e) => /Duplicate key name|already exists/i.test(String(e?.message || ''));

  async function ensureColumn(table, colSql) {
    try {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${colSql}`);
      console.log(`✅ Added column to ${table}: ${colSql.split(' ')[0]}`);
    } catch (e) {
      if (!isDupErr(e)) console.error(`⚠️ Column add error on ${table}:`, e.message);
    }
  }

  async function ensureIndex(sql) {
    try {
      await pool.query(sql);
      console.log(`✅ Executed index statement`);
    } catch (e) {
      if (!isDupKeyErr(e)) console.error(`⚠️ Index error:`, e.message);
    }
  }

  try {
    // 1. Enhance activity_ticket_types to support Entry, Rides, Activities, and Passes
    await ensureColumn('activity_ticket_types', "product_type ENUM('ENTRY', 'RIDE', 'ACTIVITY', 'PASS') DEFAULT 'ENTRY'");
    await ensureColumn('activity_ticket_types', "image_url VARCHAR(500) NULL");
    await ensureColumn('activity_ticket_types', "daily_capacity INT DEFAULT 200");
    await ensureColumn('activity_ticket_types', "requires_entry TINYINT(1) DEFAULT 0");
    await ensureColumn('activity_ticket_types', "approval_status ENUM('PENDING', 'APPROVED', 'REJECTED') DEFAULT 'APPROVED'");
    await ensureColumn('activity_ticket_types', "admin_feedback TEXT NULL");
    await ensureColumn('activity_ticket_types', "terms TEXT NULL");

    // 2. Enhance activity_booking_items to track item-level redemptions for a single booking QR
    await ensureColumn('activity_booking_items', "redeemed_quantity INT DEFAULT 0");
    await ensureColumn('activity_booking_items', "status VARCHAR(20) DEFAULT 'VALID'");

    // 3. Enhance activity_qr_scan_logs for auditable redemption logs
    await ensureColumn('activity_qr_scan_logs', "booking_item_id INT NULL");
    await ensureColumn('activity_qr_scan_logs', "venue_id INT NULL");

    // 4. Performance Indexes
    await ensureIndex('CREATE INDEX idx_activity_tt_activity_id ON activity_ticket_types (activity_id, is_active)');
    await ensureIndex('CREATE INDEX idx_activity_inv_lookup ON activity_inventory (activity_id, date, ticket_type_id)');
    await ensureIndex('CREATE INDEX idx_activity_tix_qr ON activity_tickets (qr_token)');
    await ensureIndex('CREATE INDEX idx_activity_tix_booking ON activity_tickets (booking_id)');
    await ensureIndex('CREATE INDEX idx_activity_bi_booking ON activity_booking_items (booking_id)');
    await ensureIndex('CREATE INDEX idx_activity_slug_status ON activities (slug, status)');

    // 5. Setup Freedom Amusement Park with complete multi-ticket products
    const [[freedom]] = await pool.query("SELECT id, owner_id FROM activities WHERE name LIKE '%Freedom%' LIMIT 1");
    if (freedom) {
      console.log(`🎡 Found Freedom Amusement Park (ID: ${freedom.id})`);
      const actId = freedom.id;

      // Update Freedom Park details (location, images, status)
      await pool.query(`
        UPDATE activities SET
          location = 'Pernambut, Gudiyatham',
          city = 'Pernambut',
          state_province = 'Tamil Nadu',
          status = 'approved',
          images = JSON_ARRAY(
            'https://images.unsplash.com/photo-1513889961551-628c1e5e2ee9?q=80&w=800',
            'https://images.unsplash.com/photo-1576013551627-0cc20b96c2a7?q=80&w=800'
          ),
          opening_days = JSON_ARRAY('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'),
          opening_time = '09:00:00',
          closing_time = '21:00:00'
        WHERE id = ?
      `, [actId]);

      // Seed multi-ticket products for Freedom Park
      const products = [
        { name: 'Adult Entry Ticket', desc: 'General admission entry pass for adults', price: 300, product_type: 'ENTRY', min_q: 1, max_q: 20, age_min: 12, age_max: 70, req_entry: 0, cap: 500, img: 'https://images.unsplash.com/photo-1513889961551-628c1e5e2ee9?q=80&w=600' },
        { name: 'Child Entry Ticket', desc: 'Admission entry pass for kids (under 12)', price: 200, product_type: 'ENTRY', min_q: 1, max_q: 10, age_min: 3, age_max: 11, req_entry: 0, cap: 300, img: 'https://images.unsplash.com/photo-1576013551627-0cc20b96c2a7?q=80&w=600' },
        { name: 'Go-Karting Adventure', desc: 'High-speed 10-lap go-kart racing track with safety gear', price: 250, product_type: 'RIDE', min_q: 1, max_q: 10, age_min: 10, age_max: 60, req_entry: 1, cap: 150, img: 'https://images.unsplash.com/photo-1594909122845-11baa439b7bf?q=80&w=600' },
        { name: 'Roller Coaster Ride', desc: 'High-adrenaline outdoor looping roller coaster ride', price: 150, product_type: 'RIDE', min_q: 1, max_q: 10, age_min: 10, age_max: 55, req_entry: 1, cap: 300, img: 'https://images.unsplash.com/photo-1513889961551-628c1e5e2ee9?q=80&w=600' },
        { name: 'Trampoline Park Zone', desc: '60 minutes of freestyle trampoline bounce arena', price: 100, product_type: 'RIDE', min_q: 1, max_q: 10, age_min: 5, age_max: 50, req_entry: 1, cap: 200, img: 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?q=80&w=600' },
        { name: 'Olympic Swimming Pool', desc: '60 minutes lane swimming with locker & shower access', price: 200, product_type: 'ACTIVITY', min_q: 1, max_q: 10, age_min: 8, age_max: 65, req_entry: 0, cap: 100, img: 'https://images.unsplash.com/photo-1530549387789-4c1017266635?q=80&w=600' },
        { name: 'VR Sci-Fi Simulator', desc: '360-degree immersive virtual reality motion ride', price: 180, product_type: 'RIDE', min_q: 1, max_q: 6, age_min: 8, age_max: 60, req_entry: 1, cap: 120, img: 'https://images.unsplash.com/photo-1622979135225-d2ba269bc1df?q=80&w=600' }
      ];

      for (let i = 0; i < products.length; i++) {
        const p = products[i];
        const [[existing]] = await pool.query('SELECT id FROM activity_ticket_types WHERE activity_id = ? AND name = ?', [actId, p.name]);
        let ttId = existing?.id;
        if (existing) {
          await pool.query(`
            UPDATE activity_ticket_types SET
              description = ?, price = ?, product_type = ?, min_quantity = ?, max_quantity = ?,
              age_min = ?, age_max = ?, requires_entry = ?, daily_capacity = ?, image_url = ?,
              is_active = 1, approval_status = 'APPROVED', sort_order = ?
            WHERE id = ?
          `, [p.desc, p.price, p.product_type, p.min_q, p.max_q, p.age_min, p.age_max, p.req_entry, p.cap, p.img, i, existing.id]);
        } else {
          const [ins] = await pool.query(`
            INSERT INTO activity_ticket_types
              (activity_id, name, description, price, product_type, min_quantity, max_quantity, age_min, age_max, requires_entry, daily_capacity, image_url, is_active, approval_status, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'APPROVED', ?)
          `, [actId, p.name, p.desc, p.price, p.product_type, p.min_q, p.max_q, p.age_min, p.age_max, p.req_entry, p.cap, p.img, i]);
          ttId = ins.insertId;
        }

        // Initialize inventory for the next 60 days for this ticket product
        const today = new Date();
        for (let d = 0; d < 60; d++) {
          const cur = new Date(today.getTime() + d * 86400000);
          const ymd = cur.toISOString().slice(0, 10);
          await pool.query(`
            INSERT INTO activity_inventory (activity_id, ticket_type_id, date, capacity, sold, is_closed)
            VALUES (?, ?, ?, ?, 0, false)
            ON DUPLICATE KEY UPDATE capacity = VALUES(capacity)
          `, [actId, ttId, ymd, p.cap]);
        }
      }
      console.log(`✅ Seeded ${products.length} products & 60-day inventory for Freedom Amusement Park`);
    }

    console.log('🎉 Activities & Multi-Ticket Database Migrations completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err);
  } finally {
    process.exit(0);
  }
}

migrateActivitiesAndTickets();
