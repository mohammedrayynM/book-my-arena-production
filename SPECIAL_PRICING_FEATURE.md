# Special Pricing Feature - BookMyArena

## Overview

The Special Pricing feature allows turf owners to set custom prices for specific time slots on specific days or dates. This is similar to how owners can control opening and closing times, but instead controls the pricing dynamically.

## Use Cases

1. **Weekend Pricing**: Charge higher prices on weekends (Saturday/Sunday)
2. **Peak Hour Pricing**: Higher prices during evening hours (6 PM - 10 PM)
3. **Holiday Pricing**: Special prices for specific dates like public holidays
4. **Off-Peak Discounts**: Lower prices during morning or afternoon slots to attract customers
5. **Event-Based Pricing**: Higher prices during special events or tournaments

## Database Schema

### `special_pricing` Table

```sql
CREATE TABLE special_pricing (
  id INT AUTO_INCREMENT PRIMARY KEY,
  turf_id INT NOT NULL,                    -- Which turf this pricing applies to
  day_of_week INT,                         -- 0=Sunday to 6=Saturday (NULL = all days)
  specific_date DATE,                      -- For one-time date overrides (NULL = recurring)
  time_slot VARCHAR(50) NOT NULL,          -- e.g., "6:00 AM - 7:00 AM"
  special_price DECIMAL(10, 2) NOT NULL,   -- The special price for this slot
  is_active BOOLEAN DEFAULT TRUE,          -- Enable/disable without deleting
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (turf_id) REFERENCES turfs(id) ON DELETE CASCADE,
  UNIQUE KEY unique_pricing (turf_id, day_of_week, specific_date, time_slot)
);
```

### Key Design Decisions

1. **Dual Mode**: Supports both recurring (by day of week) and one-time (specific date) pricing
2. **Priority**: Specific dates take precedence over day-of-week pricing
3. **Flexibility**: Can set different prices for each time slot individually
4. **Performance**: Indexed on (turf_id, specific_date) and (turf_id, day_of_week) for fast lookups

## API Endpoints

### Owner Routes (`/api/owners/turfs/:id/special-pricing`)

#### 1. Get Special Pricing for a Turf
```
GET /api/owners/turfs/:id/special-pricing
```
Returns all special pricing entries for the specified turf.

#### 2. Set Special Pricing (Single)
```
POST /api/owners/turfs/:id/special-pricing
Body: {
  day_of_week: 0-6 | null,    // Optional, for recurring pricing
  specific_date: "2024-12-25" | null,  // Optional, for specific date
  time_slot: "6:00 AM - 7:00 AM",
  special_price: 1500
}
```
Creates or updates a special price entry.

#### 3. Set Special Pricing (Bulk)
```
POST /api/owners/turfs/:id/special-pricing/bulk
Body: {
  entries: [
    { day_of_week: 0, time_slot: "6:00 AM - 7:00 AM", special_price: 1200 },
    { day_of_week: 0, time_slot: "7:00 AM - 8:00 AM", special_price: 1300 },
    // ... more entries
  ]
}
```
Useful for setting multiple prices at once.

#### 4. Delete Special Pricing
```
DELETE /api/owners/turfs/:id/special-pricing/:pricingId
```
Deletes a specific pricing entry.

### Public Turf Routes (`/api/turfs/:id/slots`)

The slots endpoint now includes pricing information:

```
GET /api/turfs/:id/slots?date=2024-12-25
```

Response:
```json
{
  "slots": [
    {
      "time": "6:00 AM - 7:00 AM",
      "status": "available",
      "price": 1200,           // Special price if exists, else base price
      "basePrice": 1000,       // Base price from turf
      "hasSpecialPrice": true  // Whether this slot has special pricing
    },
    // ... more slots
  ],
  "basePrice": 1000
}
```

### Booking Routes (`/api/bookings`)

When creating a booking, the system automatically checks for special pricing:

```
POST /api/bookings
Body: {
  turf_id: 1,
  booking_date: "2024-12-25",
  time_slot: "6:00 AM - 7:00 AM",
  // ... other fields
}
```

The booking amount is calculated as:
1. Check for specific date pricing first
2. If not found, check for day-of-week pricing
3. If not found, use base price from turf

## Frontend Implementation

### Owner Dashboard - Special Pricing Tab

The owner dashboard includes a new "💲 Special Pricing" tab with:

1. **Form Section** (Left):
   - Select turf dropdown
   - Pricing type toggle (Recurring vs Specific Date)
   - Day of week or Date picker (based on selection)
   - Time slot dropdown (generated from turf's opening/closing times)
   - Special price input
   - Save button

2. **List Section** (Right):
   - Table showing all current special prices
   - Shows Day/Date, Time Slot, Special Price
   - Delete button for each entry

### Customer Turf Detail Page

The slot selection now shows:
- Regular slots with "Regular price" label
- Special price slots with the actual price displayed in gold color
- Booking summary shows the correct price for the selected slot

## Migration

To add the special pricing feature to an existing database:

```bash
cd server
node migrate-special-pricing.js
```

This will:
1. Create the `special_pricing` table
2. Add necessary indexes for performance
3. Set up foreign key relationships

## Examples

### Example 1: Set Weekend Premium Pricing

```javascript
// Set higher prices for all weekend slots
const weekendEntries = [];
const slots = ["6:00 AM - 7:00 AM", "7:00 AM - 8:00 AM", /* ... */];
const premium = 1500; // 50% increase from base 1000

for (const day of [0, 6]) { // Sunday and Saturday
  for (const slot of slots) {
    weekendEntries.push({
      day_of_week: day,
      time_slot: slot,
      special_price: premium
    });
  }
}

await apiPost('/owners/turfs/1/special-pricing/bulk', { entries: weekendEntries });
```

### Example 2: Set Holiday Pricing

```javascript
// Set special pricing for Christmas Day
await apiPost('/owners/turfs/1/special-pricing', {
  specific_date: '2024-12-25',
  time_slot: '6:00 AM - 7:00 AM',
  special_price: 2000  // Double price for Christmas
});
```

### Example 3: Off-Peak Discounts

```javascript
// Lower prices for early morning slots (6-9 AM) on weekdays
const discountEntries = [];
const morningSlots = ["6:00 AM - 7:00 AM", "7:00 AM - 8:00 AM", "8:00 AM - 9:00 AM"];
const discountPrice = 700; // 30% discount

for (const day of [1, 2, 3, 4, 5]) { // Monday to Friday
  for (const slot of morningSlots) {
    discountEntries.push({
      day_of_week: day,
      time_slot: slot,
      special_price: discountPrice
    });
  }
}

await apiPost('/owners/turfs/1/special-pricing/bulk', { entries: discountEntries });
```

## Testing

### Manual Testing Steps

1. **Setup**:
   ```bash
   # Run migration
   cd server
   node migrate-special-pricing.js
   
   # Start server
   npm start
   
   # Start client in another terminal
   cd client
   npm run dev
   ```

2. **Owner Dashboard**:
   - Log in as an owner
   - Navigate to "Special Pricing" tab
   - Select a turf
   - Set a special price for a specific day/time
   - Verify it appears in the list
   - Delete it and verify removal

3. **Customer Booking**:
   - Browse turfs as a customer
   - Select a turf with special pricing
   - Choose a date that has special pricing
   - Verify slots show correct prices
   - Complete booking and verify charged amount

### API Testing

```bash
# Get special pricing
curl http://localhost:5000/api/owners/turfs/1/special-pricing \
  -H "Authorization: Bearer YOUR_TOKEN"

# Set special pricing
curl -X POST http://localhost:5000/api/owners/turfs/1/special-pricing \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "day_of_week": 0,
    "time_slot": "6:00 AM - 7:00 AM",
    "special_price": 1500
  }'

# Get slots with pricing
curl "http://localhost:5000/api/turfs/1/slots?date=2024-12-25"
```

## Future Enhancements

1. **Bulk Edit**: Edit multiple prices at once
2. **Copy Pricing**: Copy pricing from one turf to another
3. **Pricing Templates**: Save and apply pricing templates
4. **Seasonal Pricing**: Set pricing for date ranges (e.g., summer season)
5. **Analytics**: Show revenue impact of special pricing
6. **A/B Testing**: Test different price points

## Files Modified

### Backend
- `database/special_pricing.sql` - Database schema
- `server/migrate-special-pricing.js` - Migration script
- `server/routes/owners.js` - Added special pricing CRUD routes
- `server/routes/turfs.js` - Updated slots endpoint to include pricing
- `server/routes/bookings.js` - Updated booking to use special pricing

### Frontend
- `client/app/owner/dashboard/page.js` - Added Special Pricing tab
- `client/app/turfs/[id]/page.js` - Updated to display special prices

## Summary

The Special Pricing feature provides turf owners with flexible control over pricing, enabling them to:
- Maximize revenue during peak times
- Attract customers during off-peak hours
- Handle special events and holidays
- Respond to market demand dynamically

The implementation is production-ready with proper validation, error handling, and performance optimization.