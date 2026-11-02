# Shipping Toadstool Kingdoms

Everything that can be built and tested without your personal accounts is in the repository. This page covers the steps only the owner can do.

## 1. Play on your devices right now (no accounts needed)

- **Web app (all devices):** https://jimhavlicekpersonal.github.io/toadstool-kingdoms/ (see the README for installing it to your home screen). The web build uses a **mock store**: purchases complete instantly and nothing is charged.
- **Android app on your Pixel 7:** every push to `main` builds an installable APK.
  1. On GitHub, open **Actions → Android app (installable APK)** and click the latest green run.
  2. Under **Artifacts**, download `toadstool-kingdoms-android-apk` and unzip it (you get `app-debug.apk`).
  3. Send the APK to the phone (Google Drive, email, or a USB cable), open it, and allow "Install unknown apps" for that app when Android asks.
  4. In-app purchases are switched off in the Android app until Google Play Billing is added (see section 5).

## 2. iPhone: TestFlight and a sandbox purchase

Apple only builds iPhone apps on a Mac. The **iOS TestFlight (manual)** workflow uses a GitHub macOS machine, so you never need your own Mac.

**One-time setup (about an hour, in a web browser):**

1. Join the **Apple Developer Program** ($99/year) at https://developer.apple.com/programs/.
2. In **Certificates, Identifiers & Profiles → Identifiers**, register an App ID. Use `com.toadstoolkingdoms.app`, or your own ID. If you use your own, also change `appId` in `capacitor.config.ts` and add a repository variable `IOS_BUNDLE_ID` with the same value.
3. In **App Store Connect → Apps**, create a new iOS app with that bundle ID.
4. In the app's **Monetization → In-App Purchases**, add these **Consumable** products. Use these exact product IDs:

   | Product ID | Price |
   | --- | --- |
   | `moonstones_1` | $1.99 |
   | `moonstones_2` | $4.99 |
   | `moonstones_3` | $9.99 |
   | `moonstones_4` | $19.99 |
   | `moonstones_5` | $49.99 |
   | `moonstones_6` | $99.99 |
   | `lantern_pass` | $4.99 |
   | `offer_starter` | $1.99 |
   | `offer_builder` | $4.99 |
   | `offer_war_prep` | $2.99 |
   | `offer_rebuild` | $2.99 |

5. In **App Store Connect → Users and Access → Integrations → App Store Connect API**, create a key with the **App Manager** role. Download the `.p8` file (you can only download it once) and note the **Key ID** and the **Issuer ID**.
6. Find your **Team ID** under **Membership** at developer.apple.com.
7. In the GitHub repository, open **Settings → Secrets and variables → Actions** and add these **secrets**:
   - `APPLE_TEAM_ID`: your Team ID
   - `ASC_KEY_ID`: the Key ID
   - `ASC_ISSUER_ID`: the Issuer ID
   - `ASC_KEY_P8_BASE64`: the `.p8` file, base64-encoded. On Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_XXXX.p8"))`

**Each build:**

1. In GitHub, go to **Actions → iOS TestFlight (manual) → Run workflow**. It takes about 15 minutes.
2. In App Store Connect → **TestFlight**, add yourself as an internal tester once the build finishes processing.
3. On the iPhone, install **TestFlight** from the App Store, accept the invite and install Toadstool Kingdoms.
4. **Sandbox purchase:** in the game, open the Store and buy a pack. TestFlight purchases use Apple's sandbox, so you are **not charged**. Apple's purchase sheet appears after the game's own confirm step.

**Testing purchases on a Mac (optional):** `ios/App/Products.storekit` lists every product. In Xcode, choose **Product → Scheme → Edit Scheme → Run → Options → StoreKit Configuration** and select it (drag it into the project first) to test purchases in the simulator without App Store Connect.

## 3. Online play (real players instead of bots)

The server in `server/` (Node + Fastify + Postgres) does five things:

- matches you with real players, using the same rules as offline play (Elder Toadstool level, leaf rank, loot penalty and loot caps);
- re-runs every battle, so results cannot be faked;
- delivers real raids against your village;
- runs real Groves (chat, troop requests and donations);
- pairs Groves for the weekly Grove Raid.

Without a server, the game uses generated opponents, bot raiders and a bot Grove, as before. Your village itself always stays on your device.

1. Create a Postgres database. Render, Railway, Neon and Supabase all have free or cheap plans; copy its connection string.
2. Deploy the server, for example on Render as a **Web Service** from this repository:
   - Build command: `npm ci && npm run server:build`
   - Start command: `npm run server:start`
   - Environment variables:
     - `DATABASE_URL`: the connection string.
     - `CORS_ORIGIN`: leave it unset to allow every origin. This is safe, because players sign in with a token, not a cookie. To restrict it, use a comma-separated list: `https://jimhavlicekpersonal.github.io,capacitor://localhost,https://localhost`. The last two are the iPhone and Android apps.
   - The tables are created on first start, and upgraded in place on later versions.
   - Use the HTTPS address the host gives you. The phone apps refuse plain HTTP.
3. Check that `https://<your-server>/v1/hello` shows `"name":"toadstool-kingdoms"`.
4. Optional: check the server against the protocol contract. On Windows PowerShell, first set the address with `$env:CONTRACT_URL="https://<your-server>"`.

   ```bash
   CONTRACT_URL=https://<your-server> npm run test:contract
   ```

5. Turn online play on, in either or both of these ways:
   - **For everyone:** in GitHub, go to **Settings → Secrets and variables → Actions → Variables** and add `VITE_SERVER_URL` = `https://<your-server>`. The next push to `main` rebuilds the web app and the Android APK with that server built in.
   - **On one device, no rebuild:** in the game, open **Settings → Online play**, type the server address and tap **Use**. **Play offline** switches back. This is handy for testing a new server before building it in.

The top bar shows the connection: **Online**, **Connecting…** or **No connection**. Battles you fight while the connection is down are sent when it comes back.

**Running a server locally:** run `npm run server:dev`. It uses memory instead of Postgres when `DATABASE_URL` is not set. In the game, set the server address to `http://localhost:8787`, or to `http://<laptop-ip>:8787` from a phone on the same Wi-Fi, using `npm run dev:lan`.

**Building a different server later:** `docs/PROTOCOL.md` describes everything the game expects. The contract tests check any server against it.

## 4. Reminders

The installed iOS/Android app schedules real local notifications when you leave the game (turn them on in Settings). The web version can only notify while the game is still open in the background.

## 5. Not done yet (decisions for later)

- **Google Play Billing** for the Android app. The `PaymentProvider` interface is ready for a Play Billing provider; purchases are disabled in the Android build until then. Publishing on Google Play also needs a Google Play Console account ($25 one-time).
- **Cloud saves across devices.** The server handles PvP, Groves and Grove Raids. Your village itself is still saved per device; use Settings → Copy save code / Load from code to move it. Moving the village economy to the server would also stop players from editing their own saves (see "Trust" in `docs/PROTOCOL.md`).
