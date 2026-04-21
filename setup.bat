@echo off
echo.
echo  ======================================
echo   BookMyArena - Project Setup
echo  ======================================
echo.

echo [1/3] Installing server dependencies...
cd /d "%~dp0server"
call npm install
echo  Server dependencies installed!
echo.

echo [2/3] Installing client dependencies...
cd /d "%~dp0client"
call npm install
echo  Client dependencies installed!
echo.

echo [3/3] Setup complete!
echo.
echo  ======================================
echo   TO START THE PROJECT:
echo  ======================================
echo.
echo   1. Update server/.env with your TiDB and Razorpay credentials
echo   2. Run the database schema: database/schema.sql
echo   3. Start server: cd server ^&^& node server.js
echo   4. Start client: cd client ^&^& npm run dev
echo.
echo   Server: http://localhost:5000
echo   Client: http://localhost:3000
echo  ======================================
echo.
pause
