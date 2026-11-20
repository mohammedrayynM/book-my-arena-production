# Book Arena: bug fixes (15 Nov 2026)

Four issues fixed: Google login on mobile, the guest "Open Login" screen, subscription payments through Razorpay, and image uploads.
Every edited file keeps its original line endings, so `git diff` shows only the real changes.

---

## 1. Root causes

| # | Problem | Root cause (verified) |
|---|---|---|
| 1 | "Google sign-in failed" on Android | Website, app and backend all use the same Web client ID, so that part is correct. The release APK (`BookMyArena-release.apk`) is signed with the **public React Native debug keystore** (`android/app/build.gradle` → `release { signingConfig signingConfigs.debug }`), SHA-1 `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`. Native Google Sign-In returns `DEVELOPER_ERROR` (code 10) unless an Android OAuth client with package `com.bookmyarena.app` and that exact SHA-1 exists in the same Google Cloud project. The app showed every error as the same generic message. |
| 1 | iOS Google login | The plugin was configured without `iosUrlScheme` and there is no iOS OAuth client ID, so iOS sign-in cannot work (and would crash). |
| 1 | Duplicate accounts | Emails were compared case-sensitively. TiDB's default collation is `utf8mb4_bin`. `Rahul@Gmail.com` (password) and `rahul@gmail.com` (Google) became two accounts. The app also lowercases emails before `/users/login`, so mixed-case website accounts **could not log in on the app**. |
| 2 | Guest login screen unclear | The Profile tab showed a plain card with an "Open Login" button, no logo and no explanation. |
| 3 | Razorpay does not open for subscriptions | `POST /subscriptions/purchase` and `/:id/renew` did not return `key_id`, unlike every other payment flow. The app opened native Razorpay with `key: undefined`, which failed immediately and was shown as "cancelled". On the **website** the missing key fell through to `process.env.REACT_APP_RAZORPAY_KEY_ID`, which throws `process is not defined` under Vite. The checkout also referenced an undefined variable `user`. |
| 4 | "Unsupported FormDataPart implementation" | Expo SDK 58 replaces the global `fetch` with `expo/fetch`, which does not support React Native's `{ uri, name, type }` file parts. Expo's own test (`convertFormData-test.native.ts`) expects exactly this error. Every mobile upload used `fetch` + FormData. The ad upload route also accepted SVG/GIF, did not check file contents and returned a generic 500 for size or format errors. |

## 2. Files changed

**Mobile (`mobile/`)**
- `services/imageUpload.js`: rewritten as the shared picker and uploader. It uses React Native's `XMLHttpRequest`, which streams `{uri}` parts natively and adds the multipart boundary. It never sets Content-Type, reports upload progress, validates JPG/JPEG/PNG (WebP is also accepted by the server), enforces a 10 MB limit, handles permission denial (with an "Open Settings" option), and gives readable messages for 401, 413, 415, 5xx, timeouts and network failures.
- `services/activityImageUpload.js`: now delegates to the shared uploader. Its API is unchanged.
- `app/(admin)/ads.jsx`: Promotions & Ads uses the shared uploader. It shows a preview right away and a progress bar, offers a retry button on failure, keeps the previously saved image when an upload fails, and blocks saving while an upload is running or has failed.
- `app/(admin)/sport-categories.jsx`: uses the shared uploader (5 MB server limit).
- `app/(owner)/activity-management/create.jsx` and `[id].jsx`: show upload progress and readable error messages.
- `lib/razorpayCheckout.js`: uses the `key_id` from the server and detects the native TurboModule on the New Architecture. If no key is available it falls back to the hosted checkout page, which gets the key from the server. It tells "cancelled" apart from "failed" (Android code 0, or a JSON description), and a definite 4xx from verification is reported with its reason.
- `app/turf/[id].jsx` and `app/subscription/[id].jsx`: pass `keyId` and `currency`, and show the reason when a payment fails.
- `lib/googleAuth.js`: adds `iosClientId` support, hides the Google button on iOS until an iOS client ID is configured, and maps native errors (10 → configuration problem, 7 → network, 12501 → cancelled) to clear messages. The real error code is logged to the device log.
- `app/(auth)/login.jsx`: adds messages for `GOOGLE_NOT_CONFIGURED`, 429, 5xx and Google-only accounts.
- `components/auth/GuestWelcome.jsx` (new) and `app/(tabs)/profile.jsx`: the new guest "Open Login" screen. It has the logo on a white disc, the headline "Sign in to start booking", a large green **Sign In** button (opens `/(auth)/login`), a separate **Create Account** button, three benefit rows, and an entry-staff link. It respects safe areas, scales for small and large screens, and caps its width at 480 dp on tablets.
- `app.config.js` (new): reads `app.json` and adds `iosUrlScheme` for the Google plugin when `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` is set. It also registers the signing plugin.
- `plugins/withAndroidReleaseSigning.js` (new) and `android/app/build.gradle`: release builds are signed with **your own upload keystore** when it is configured in your user-level `gradle.properties`. Without it, the build falls back to the debug keystore exactly as before.

**Backend (`server/`)**
- `routes/subscriptions.js`: `/purchase` and `/:id/renew` now return `key_id` (the public key only; the secret never leaves the server).
- `routes/users.js`: email lookups are case-insensitive for register, login and google-login. Google sign-in links to the existing account instead of creating a duplicate. Google-only accounts get a clear message on password login instead of a 500 from `bcrypt.compare(null)`. Optional extra audiences are read from `GOOGLE_CLIENT_IDS`. The reason a token was rejected is logged.
- `routes/admin-ads.js`: only JPG/PNG/WEBP are accepted, file contents are checked by magic bytes, mislabelled files are renamed to their real extension, SVG is rejected, and errors return 413/415/400 JSON instead of 500.

**Website (`client/`)**
- `src/pages/TurfDetail.jsx`: subscription checkout uses the server's `key_id` (falling back to `import.meta.env.VITE_RAZORPAY_KEY_ID`) and `currentUser` for prefill. A failed attempt no longer closes the flow, because Razorpay lets the customer retry inside the same window. Paid, failed, cancelled and unconfirmed outcomes each get the right message.

No Razorpay credentials, database records, storage provider or other payment flows (turf booking, tournaments, venue billing, activities) were changed.

## 3. app.json / app.config.js

`app.json` is unchanged. The new `app.config.js` builds on it:
- Google plugin: bare (Android needs nothing more) → `["@react-native-google-signin/google-signin", { "iosUrlScheme": "com.googleusercontent.apps.<ios-id>" }]` once `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` is set.
- `extra.googleIosClientId` is added when set.
- `./plugins/withAndroidReleaseSigning` is appended.

## 4. What YOU must configure

### Google Cloud Console: project `364238295539` (the one that owns the Web client)
1. **APIs & Services → Credentials → Create credentials → OAuth client ID → Android**
   - Package name: `com.bookmyarena.app`
   - SHA-1: create **one Android client per signing key** you use:
     - Current local APKs (debug keystore): `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`. This is enough to make the APK you tested work. If Google says the fingerprint is already in use, use your own keystore (step 2).
     - Your upload keystore (step 2): `keytool -list -v -keystore C:\keys\bookarena-upload.jks -alias bookarena-upload`
     - EAS builds: SHA-1 from `eas credentials -p android`
     - Play Store installs: Play Console → *Test and release → App integrity → App signing key certificate* SHA-1
2. **OAuth consent screen** must be **In production** (or your testers must be added as test users).
3. **iOS:** Create credentials → OAuth client ID → **iOS**, Bundle ID `com.bookmyarena.app`. Put its client ID in `mobile/.env` and in both `eas.json` profiles:
   `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com`
4. Admin panel → Authentication settings → Google login must stay **ON** (the server enforces it).

### Android upload keystore (once; keep the file and passwords safe and out of git)
```
keytool -genkeypair -v -storetype JKS -keystore C:\keys\bookarena-upload.jks -alias bookarena-upload -keyalg RSA -keysize 2048 -validity 10000
```
Add these lines to `%USERPROFILE%\.gradle\gradle.properties`:
```
BOOKARENA_UPLOAD_STORE_FILE=C:/keys/bookarena-upload.jks
BOOKARENA_UPLOAD_STORE_PASSWORD=********
BOOKARENA_UPLOAD_KEY_ALIAS=bookarena-upload
BOOKARENA_UPLOAD_KEY_PASSWORD=********
```
Google Play rejects debug-signed bundles, so you need this before uploading an AAB.

### Razorpay
No credential changes. Check in the Razorpay Dashboard → Webhooks that `https://bookarena.in/api/bookings/webhook` is active for `payment.captured`, `refund.processed` and `refund.failed`, and that its secret equals `RAZORPAY_WEBHOOK_SECRET` on the server. The webhook activates a paid subscription even if the phone dies right after payment.

## 5. Tests performed (in the cloud sandbox, against the changed code)

| Area | Test | Result |
|---|---|---|
| Diagnosis | Read the signing certificate of `BookMyArena-release.apk` | Debug keystore SHA-1 confirmed |
| Uploads | Shared uploader run against the real `admin-ads` route (Express 5 + Multer 2) with a React Native–style FormData/XHR shim | PNG ✅, `.jpeg` ✅, no name or mime (Android `content://`) ✅, HEIC rejected on the device ✅, SVG disguised as PNG → 415 ✅, 11 MB → rejected on the device, or 413 from the server ✅, expired token → 401 message ✅, server down → network message ✅, permission permanently denied → "Open Settings" ✅, picker cancelled ✅, progress callback ✅, no Content-Type header set ✅ |
| Ad route | Direct multipart tests | Owner token → 403; wrong field → 400; only valid images stored on disk ✅ |
| Subscriptions API | `/purchase` and `/renew` | Return `key_id` (public key only) ✅; owner token → 403 ✅; forged signature → 400, nothing activated ✅; valid signature → activation called once with the order's own records ✅ |
| Mobile checkout | `payWithRazorpay` with a stubbed native SDK | Native opens with the server key ✅; missing key → hosted page instead of a broken native sheet ✅; cancel (code 0, or a JSON description) → "cancelled" ✅; bank decline → "failed" with reason ✅; verify 409 → "failed" + refunded ✅; verify network error → "unknown", then the app asks the backend ✅ |
| Google/accounts | `users.js` with a case-sensitive fake DB | Old code: 5 accounts for 2 people, and app login failed for mixed-case emails. New code: 2 accounts, Google linked to the existing password account ✅, conflicting Google ID → 409 ✅, unverified email → 401 ✅, bad token → 401 + logged reason ✅ |
| Build config | `app.config.js` evaluated with and without the iOS client ID; signing plugin transform run on the real `build.gradle` (idempotent) | ✅ |
| Code | All changed files parse; ESLint `no-undef` / `jsx-no-undef` | 0 errors ✅ |

**Not tested yet:** an installed Android/iOS build, a real Razorpay **test-mode** payment, and a browser run of the website. The server `.env` holds **live** Razorpay keys, so I did not run a payment against it. See section 7.

## 6. Commands

Backend (EC2):
```
cd server && npm install && pm2 restart bookmyarena-api
```
Website:
```
cd client && npm install && npm run build
```
Android APK / AAB (Windows, uses the existing `android/` folder; **do not** run `expo prebuild --clean`, because it would drop your manual Windows CMake fix in `android/build.gradle`):
```
cd mobile
npm install
cd android
.\gradlew.bat clean
.\gradlew.bat assembleRelease     # APK  -> android\app\build\outputs\apk\release\app-release.apk
.\gradlew.bat bundleRelease       # AAB  -> android\app\build\outputs\bundle\release\app-release.aab
```
Check which key signed it (this SHA-1 must be registered in Google Cloud):
```
keytool -printcert -jarfile android\app\build\outputs\apk\release\app-release.apk
```
Or with EAS: `eas build -p android --profile preview` (APK) / `--profile production` (AAB).

iOS (needs an Apple Developer account; Windows cannot build iOS locally):
```
cd mobile
eas build -p ios --profile production
```
(On a Mac you can also use `npx expo prebuild -p ios && npx expo run:ios --configuration Release`.)

## 7. Remaining items / how to verify on device
1. Register the SHA-1(s) above, rebuild, install, and tap **Continue with Google**. If it still fails, the alert now shows `(error N)`, and `adb logcat | findstr google-signin` shows the exact code.
2. Razorpay test mode: run a staging copy of the server with `rzp_test_…` keys. Owner creates a plan → customer subscribes → pay with test card `4111 1111 1111 1111` → check *My subscriptions* shows ACTIVE. Then cancel once and use a failing test card once.
3. Upload a JPG and a PNG in Promotions & Ads, Sport Categories and Activity images, then restart the app and check the images still show.
4. Existing duplicate accounts created before this fix are **not merged automatically**. Find them with:
   `SELECT LOWER(email) e, COUNT(*) FROM users GROUP BY e HAVING COUNT(*) > 1;`
