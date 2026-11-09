#!/bin/bash
###############################################################################
# BookMyArena — EC2 Deployment Script (Ubuntu)
# 
# This script sets up the backend (Node.js + Express) and serves the frontend
# (Vite React build) via Nginx reverse proxy on an AWS EC2 Ubuntu instance.
#
# Usage: Copy this script to the EC2 instance and run:
#   chmod +x ec2-deploy.sh && sudo ./ec2-deploy.sh
###############################################################################

set -e

echo "============================================="
echo "  BookMyArena — EC2 Deployment"
echo "============================================="

# ---------------------------------------------------
# 1. System Update & Install Dependencies
# ---------------------------------------------------
echo ""
echo ">>> Step 1: Updating system and installing dependencies..."
sudo apt-get update -y
sudo apt-get install -y curl git unzip nginx

# Install Node.js 20 LTS (if not installed)
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 18 ]]; then
    echo ">>> Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

echo "Node version: $(node -v)"
echo "NPM version: $(npm -v)"

# Install PM2 globally (process manager)
if ! command -v pm2 &> /dev/null; then
    echo ">>> Installing PM2..."
    sudo npm install -g pm2
fi

# ---------------------------------------------------
# 2. Create application directory
# ---------------------------------------------------
APP_DIR="/home/ubuntu/bookmyarena"
echo ""
echo ">>> Step 2: Setting up application directory at $APP_DIR..."

mkdir -p $APP_DIR
cd $APP_DIR

# ---------------------------------------------------
# 3. Extract deployment package
# ---------------------------------------------------
echo ""
echo ">>> Step 3: Extracting deployment package..."

if [ -f "/home/ubuntu/deploy-bookmyarena.zip" ]; then
    unzip -o /home/ubuntu/deploy-bookmyarena.zip -d $APP_DIR
    echo "Extracted deployment package."
else
    echo "ERROR: /home/ubuntu/deploy-bookmyarena.zip not found!"
    echo "Please upload the deploy-bookmyarena.zip file to /home/ubuntu/ first."
    echo ""
    echo "From your local machine, run:"
    echo "  scp deploy-bookmyarena.zip ubuntu@<EC2-PUBLIC-IP>:/home/ubuntu/"
    exit 1
fi

# ---------------------------------------------------
# 4. Install server dependencies
# ---------------------------------------------------
echo ""
echo ">>> Step 4: Installing server dependencies..."
cd $APP_DIR/server
npm install --production

# ---------------------------------------------------
# 5. Create production .env file
# ---------------------------------------------------
echo ""
echo ">>> Step 5: Setting up production .env..."

# Check if .env already exists; if not, the one from the zip will be used.
if [ -f ".env" ]; then
    echo ".env already exists. Updating for production..."
    # Update CLIENT_URL for production
    sed -i 's|^CLIENT_URL=.*|CLIENT_URL=https://bookarena.in|' .env
    sed -i 's|^NODE_ENV=.*|NODE_ENV=production|' .env
else
    echo "Using .env from deployment package."
fi

# ---------------------------------------------------
# 6. Start/Restart the backend with PM2
# ---------------------------------------------------
echo ""
echo ">>> Step 6: Starting backend with PM2..."

cd $APP_DIR/server

# Stop existing instance if running
pm2 delete bookmyarena-api 2>/dev/null || true

# Start the server
pm2 start server.js --name "bookmyarena-api" --env production

# Save PM2 config so it auto-starts on reboot
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu 2>/dev/null || true

echo "Backend started on port 9000"

# ---------------------------------------------------
# 7. Configure Nginx as reverse proxy
# ---------------------------------------------------
echo ""
echo ">>> Step 7: Configuring Nginx..."

sudo tee /etc/nginx/sites-available/bookmyarena > /dev/null <<'NGINX_CONF'
server {
    listen 80;
    server_name bookarena.in www.bookarena.in _;

    # Client static files (React build)
    root /home/ubuntu/bookmyarena/client/dist;
    index index.html;

    # Max upload size for turf images etc.
    client_max_body_size 20M;

    # API reverse proxy to Node.js backend
    location /api/ {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }

    # Serve uploaded images
    location /uploads/ {
        alias /home/ubuntu/bookmyarena/server/uploads/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Static assets caching
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    # SPA fallback — all other routes go to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
}
NGINX_CONF

# Enable the site
sudo ln -sf /etc/nginx/sites-available/bookmyarena /etc/nginx/sites-enabled/bookmyarena
sudo rm -f /etc/nginx/sites-enabled/default

# Test and restart Nginx
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx

echo ""
echo "============================================="
echo "  ✅ Deployment Complete!"
echo "============================================="
echo ""
echo "Backend API:  http://<EC2-PUBLIC-IP>:9000/api/health"
echo "Website:      http://<EC2-PUBLIC-IP>"
echo ""
echo "Useful commands:"
echo "  pm2 logs bookmyarena-api    — View backend logs"
echo "  pm2 restart bookmyarena-api — Restart backend"
echo "  pm2 status                  — Check process status"
echo "  sudo nginx -t               — Test Nginx config"
echo "  sudo systemctl restart nginx — Restart Nginx"
echo ""

