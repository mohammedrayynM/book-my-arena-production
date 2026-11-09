const http = require('http');
const fs = require('fs');
const path = require('path');

const apkPath = path.join(__dirname, 'BookMyArena-release.apk');

http.createServer((req, res) => {
  if (!fs.existsSync(apkPath)) {
    res.writeHead(404);
    return res.end('APK not found');
  }
  const stat = fs.statSync(apkPath);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Disposition': 'attachment; filename="BookMyArena-release.apk"',
    'Content-Length': stat.size
  });
  fs.createReadStream(apkPath).pipe(res);
}).listen(8080, '0.0.0.0', () => {
  console.log('APK download server listening on http://0.0.0.0:8080');
});
