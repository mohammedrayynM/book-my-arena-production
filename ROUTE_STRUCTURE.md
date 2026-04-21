# BookMyArena - Panel Route Structure & Working URLs

## 📍 Working URLs for All Panels

### User Panel
- **Dashboard**: `http://localhost:3000/turfs` (Browse and book turfs)
- **Booking**: `http://localhost:3000/turfs/[id]` (Book specific turf)

### Owner Panel
- **Dashboard**: `http://localhost:3000/owner/dashboard`
- **Login**: `http://localhost:3000/owner/login`
- **Register**: `http://localhost:3000/owner/register`

### Admin Panel
- **Dashboard**: `http://localhost:3000/admin/dashboard`
- **Login**: `http://localhost:3000/admin/login`

## 🔄 API Routes Structure

### Owner Routes (`/api/owners`)

#### Authentication
- `POST /api/owners/register` - Owner registration
- `POST /api/owners/login` - Owner login

#### Profile & Turfs
- `GET /api/owners/profile` - Get owner profile
- `GET /api/owners/turfs` - Get owner's turfs
- `POST /api/owners/turfs` - Add new turf
- `PUT /api/owners/turfs/:id` - Edit turf
- `DELETE /api/owners/turfs/:id` - Delete turf

#### Bookings (NET AMOUNT ONLY)
- `GET /api/owners/bookings` - Get bookings with **netAmount** (after commission)
  - Returns: `id`, `customer_name`, `booking_date`, `time_slot`, `netAmount`, `status`
  - **DOES NOT RETURN**: Original price, commission percentage, commission amount

#### Earnings (NET ONLY)
- `GET /api/owners/earnings` - Get earnings data
  - Returns: `total` (net), `today` (net), `monthly` (net)
  - **DOES NOT RETURN**: `commission_percent`, `commission_deducted`, gross amounts

#### Special Pricing
- `GET /api/owners/turfs/:id/special-pricing` - Get special pricing
- `POST /api/owners/turfs/:id/special-pricing` - Set special pricing
- `DELETE /api/owners/turfs/:id/special-pricing/:pricingId` - Delete special pricing

#### Slot Control
- `POST /api/owners/turfs/:id/block-slot` - Block a slot
- `DELETE /api/owners/turfs/:id/unblock-slot` - Unblock a slot

### Admin Routes (`/api/admin`)

#### Authentication
- `POST /api/admin/login` - Admin login

#### Dashboard (FULL COMMISSION DETAILS)
- `GET /api/admin/dashboard` - Get dashboard stats
  - Returns: `total_revenue`, `platform_revenue`, `commission_percent`

#### Turf Management
- `GET /api/admin/turfs` - View all turfs
- `POST /api/admin/turfs` - Add turf
- `PUT /api/admin/turfs/:id` - Edit turf
- `DELETE /api/admin/turfs/:id` - Delete turf

#### Owner Management
- `GET /api/admin/owners` - View all owners
- `PUT /api/admin/owners/:id/approve` - Approve owner
- `PUT /api/admin/owners/:id/reject` - Reject owner
- `PUT /api/admin/owners/:id/block` - Block/unblock owner

#### Booking Management (FULL DETAILS)
- `GET /api/admin/bookings` - View all bookings with full details
  - Returns: `amount` (gross), all booking details
- `PUT /api/admin/bookings/:id/cancel` - Cancel booking

#### Settings
- `PUT /api/admin/settings/commission` - Update commission percentage

### Booking Routes (`/api/bookings`)

#### User Booking
- `POST /api/bookings` - Create new booking
- `POST /api/bookings/verify` - Verify Razorpay payment
- `GET /api/bookings/:id` - Get booking details

## 🛡️ Security Implementation

### Owner Data Protection
1. **Backend Security**:
   - Owner bookings API calculates `netAmount` server-side
   - Commission percentage is NEVER sent to owner endpoints
   - Earnings API returns only net amounts

2. **Frontend Security**:
   - Owner dashboard shows only net earnings
   - No commission breakdown displayed
   - Booking tables show "Final Earned Amount" only

3. **API Response Filtering**:
   - Owner endpoints filter out sensitive fields
   - Admin endpoints retain full details for platform management

### Admin Access
- Admin panel retains full visibility of:
  - Original booking prices
  - Commission percentages
  - Commission amounts deducted
  - Owner payout amounts

## 📊 Data Flow Example

### Booking Flow (₹1000 booking, 5% commission)

**Owner Sees:**
```json
{
  "id": 123,
  "customer_name": "Rahul",
  "booking_date": "2024-01-15",
  "time_slot": "6-7 PM",
  "netAmount": 950,
  "status": "confirmed"
}
```

**Admin Sees:**
```json
{
  "id": 123,
  "customer_name": "Rahul",
  "booking_date": "2024-01-15",
  "time_slot": "6-7 PM",
  "amount": 1000,
  "status": "confirmed"
}
```
*(Admin calculates commission: ₹1000 × 5% = ₹50, Owner gets ₹950)*

## 🎯 Key Changes Implemented

### 1. Owner Dashboard Changes
- ✅ Removed commission percentage display
- ✅ Removed deducted amount display
- ✅ Shows only net earnings (final amount after deduction)
- ✅ Labels updated to "Today's Earnings" / "Net Earnings"

### 2. Booking Table Changes (Owner Side)
- ✅ Removed "Price" column completely
- ✅ Shows: Booking ID, User Name, Time Slot, Status, Final Earned Amount
- ✅ No original price or commission visible

### 3. Backend Logic Updates
- ✅ Commission calculation kept internal (admin only)
- ✅ Owner API returns ONLY `netAmount`
- ✅ Earnings API returns only net amounts

### 4. Admin Panel (No Change)
- ✅ Admin still sees full booking price
- ✅ Admin sees commission % and deducted amount
- ✅ Admin sees owner payout

### 5. User Panel (No Change)
- ✅ User sees full booking price

## 🚀 How to Test

1. **Start the application**:
   ```bash
   # Terminal 1 - Backend
   cd server
   npm start

   # Terminal 2 - Frontend
   cd client
   npm run dev
   ```

2. **Test Owner Panel**:
   - Login as owner at `http://localhost:3000/owner/login`
   - Navigate to dashboard
   - Verify only net earnings are shown
   - Check bookings table - no price/commission visible

3. **Test Admin Panel**:
   - Login as admin at `http://localhost:3000/admin/login`
   - Navigate to dashboard
   - Verify full commission details are visible
   - Check bookings table - all financial details visible

## 📝 Notes

- Commission is calculated server-side and never exposed to owners
- All owner-facing amounts are net (after commission deduction)
- Admin has complete financial visibility for platform management
- User experience unchanged - they see the full booking price
- Security enforced at both API and frontend levels