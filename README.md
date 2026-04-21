# BookMyArena

A comprehensive turf booking platform built with Next.js and Node.js.

## Features

- 🏟️ Turf discovery and booking system
- 👤 Owner dashboard for managing turfs and bookings
- 👨‍💼 Admin panel for platform management
- 💳 Payment integration with Razorpay
- 📧 Email notifications for bookings
- 💰 Special pricing and coupon system
- 📱 Responsive design with modern UI

## Tech Stack

- **Frontend**: Next.js 16, React 19
- **Backend**: Node.js, Express.js
- **Database**: TiDB (MySQL compatible)
- **Authentication**: JWT (JSON Web Tokens)
- **Payments**: Razorpay
- **Email**: Nodemailer
- **Styling**: Custom CSS with CSS Variables

## Local Development

### Prerequisites

- Node.js 18 or higher
- MySQL database (TiDB recommended for production)

### Setup Instructions

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd bookmyarena
   ```

2. **Install dependencies**

   For the frontend:
   ```bash
   cd client
   npm install
   ```

   For the backend:
   ```bash
   cd ../server
   npm install
   ```

3. **Set up environment variables**

   Copy the example files and configure:
   ```bash
   cp server/.env.example server/.env
   # Edit server/.env with your values
   ```

4. **Database setup**

   - Create a TiDB cluster at [tidbcloud.com](https://tidbcloud.com)
   - Update the database credentials in `server/.env`
   - Run migrations:
     ```bash
     cd server
     node migrate.js
     ```

5. **Start the development servers**

   Terminal 1 - Backend:
   ```bash
   cd server
   npm start
   ```

   Terminal 2 - Frontend:
   ```bash
   cd client
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000) in your browser.

## Deployment Guide

### 1. Database Setup (TiDB)

1. Create a TiDB Serverless cluster at [tidbcloud.com](https://tidbcloud.com)
2. Get your connection details (Host, Port, Username, Password)
3. Create a database named `bookmyarena`
4. Run the migration scripts:
   ```bash
   # Connect to your TiDB instance and run:
   node migrate.js
   ```

### 2. Backend Deployment (Render)

1. **Push code to GitHub**
   ```bash
   git add .
   git commit -m "Ready for deployment"
   git push origin main
   ```

2. **Deploy on Render**
   - Go to [render.com](https://render.com) and create a new Web Service
   - Connect your GitHub repository
   - Set the following:
     - **Build Command**: `npm install`
     - **Start Command**: `npm start`
     - **Environment**: Node
   - Add environment variables (see below)

### 3. Frontend Deployment (Vercel)

1. **Deploy on Vercel**
   - Go to [vercel.com](https://vercel.com) and create a new project
   - Connect your GitHub repository
   - Vercel will auto-detect Next.js settings
   - Add environment variables (see below)

### Environment Variables Configuration

#### Backend Environment Variables (Render)

Add these in your Render service settings:

```
PORT=5000
NODE_ENV=production
DB_HOST=your-tidb-host.tidbcloud.com
DB_PORT=4000
DB_USER=your-username
DB_PASSWORD=your-password
DB_NAME=bookmyarena
DB_SSL=true
JWT_SECRET=your-super-secret-jwt-key-change-this
RAZORPAY_KEY_ID=your-razorpay-key-id
RAZORPAY_KEY_SECRET=your-razorpay-key-secret
CLIENT_URL=https://your-vercel-app.vercel.app
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_app_password_here
RAZORPAY_WEBHOOK_SECRET=your-webhook-secret
```

#### Frontend Environment Variables (Vercel)

Add these in your Vercel project settings:

```
NEXT_PUBLIC_API_URL=https://your-render-app.onrender.com/api
```

### 4. Post-Deployment Configuration

1. **Update CORS settings**: In Render, update `CLIENT_URL` to your Vercel deployment URL
2. **Test the application**: Visit your Vercel URL and ensure everything works
3. **Set up domain**: Optionally configure custom domains on Vercel and Render

## Database Schema

The application uses the following main tables:
- `turfs` - Turf information
- `owners` - Turf owners
- `bookings` - Booking records
- `coupons` - Discount coupons
- `special_pricing` - Custom pricing rules
- `settings` - Platform settings

Run `server/migrate.js` to set up all tables and initial data.

## API Documentation

The backend provides RESTful APIs:

- `/api/turfs` - Turf management
- `/api/bookings` - Booking operations
- `/api/owners` - Owner management
- `/api/coupons` - Coupon system
- `/api/admin` - Admin functions

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the ISC License.

## Support

For questions or issues, please open a GitHub issue or contact the development team.