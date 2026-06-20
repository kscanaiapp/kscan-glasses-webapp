# Investor Demo Talk Track — K Scan MRBD Virtual Alpha

**Date:** 2026-06-19  
**Demo URL:** https://kscan-glasses-demo.vercel.app  
**Simulator URL:** https://kscan-glasses-demo.vercel.app/simulator.html  
**Status:** Virtual alpha — browser-testable, not physically validated on Meta Ray-Ban Display glasses.

---

## Opening (15 seconds)

> "This is the public virtual alpha for K Scan on Meta Ray-Ban Display-style web apps. It's a 600×600 glasses HUD you can test in any browser right now."

---

## What to Show (2–3 minutes)

### 1. The HUD (Home screen)
- Point to the **K Scan** branding.
- Point to **"Find what you're looking at."**
- Point to the **Scan** primary action.
- Mention: *"This is the actual product surface — the same UI that will render on the glasses waveguide."*

### 2. The Simulator
- Open the **simulator** in a second tab.
- Explain: *"The simulator stands in for the phone + glasses capture path. In production, this is a real photo from the glasses camera, piped through the DAT mobile bridge."*
- Select **"success"** scenario.

### 3. The Scan Flow
- Click **Start Scan** (or press Enter on the Scan button).
- Show **Processing**: *"Analyzing scan..."* with active spinner.
- Show **Results**: product cards appear.
- Navigate to a result card, press Enter to **Save**.
- Show **Saved** state.

### 4. Library
- Open **Library**.
- Show the saved item (metadata-only: brand, name, price).
- Mention: *"We never store images or raw payloads in the library. Only sanitized metadata."*

### 5. Settings
- Open **Settings**.
- Show **Guest** status, **Simulator active**, **Voice: future device test**.
- This sets honest expectations.

### 6. Failure Handling
- Return to simulator, select **"timeout"** or **"phone asleep"**.
- Run scan again.
- Show clean error: *"Unable to capture. Try again."*
- Press **Home** or retry — no stale results, no payload logs.
- Mention: *"The app handles bridge failures gracefully. No crashes, no leaked data."*

---

## What to Say (Key Lines)

| Moment | Line |
|--------|------|
| HUD | "The HUD and pipeline are built as a web app. The 600×600 viewport matches the MRBD waveguide format." |
| Simulator | "The simulator stands in for the phone/glasses capture path. In production, this is a real photo from the device camera." |
| Privacy | "Images are sanitized with on-device MediaPipe face masking before any backend upload. Privacy is enforced by design, not by policy." |
| Bridge | "The DAT bridge contract is prepared for iOS/Android companion app integration. The event protocol and payload validation are in place." |
| Next milestone | "Physical glasses and DAT validation are scheduled as the next milestone when the Meta Ray-Ban Display hardware arrives." |

---

## What NOT to Claim (Hard Stop)

- ❌ Do not say physical glasses have been tested.
- ❌ Do not say real DAT capture has been validated.
- ❌ Do not say voice is production-ready.
- ❌ Do not say offline mode is production-ready.
- ❌ Do not say this is production-ready.
- ❌ Do not imply real user data is being collected.
- ❌ Do not say the backend is processing live fashion images.

**Correct framing:** *"The architecture is built. The contracts are ready. The next step is hardware integration."*

---

## Closing (10 seconds)

> "This is a browser-testable virtual alpha. The HUD, navigation, scan flow, privacy pipeline, and bridge contract are functional today. Physical Meta Ray-Ban Display testing is the next milestone."

---

## Quick Reference: Demo URLs

| Purpose | URL |
|---------|-----|
| Public demo (investor) | https://kscan-glasses-demo.vercel.app |
| Simulator (control room) | https://kscan-glasses-demo.vercel.app/simulator.html |
| Internal protected preview | https://kscan-glasses-webapp-ouj5cxqrd-justinlandes-projects.vercel.app |
