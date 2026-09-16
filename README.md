# Advanced Telegram Prediction Bot v4.2 Premium Command Deck

## New in v4.2 Premium Command Deck
- Advanced analytics panel: result trend, win-rate, loss heatmap, hold history, user management, and session analytics.
- Persistent result/hold analytics history.

## New in v4
- Consecutive LOSS -> automatic HOLD for configurable periods.
- Example: 3 losses -> hold next 2 periods -> resume automatically.
- If another loss streak reaches the threshold later, the hold triggers again.
- Rich Telegram `/panel` with dashboard-style navigation.
- Engine settings, hold settings, schedule editor, subscription manager, message editor.
- Premium expiry dates and automatic expiry handling.
- 1m / 30s modes.
- API fallback and genuinely new-period detection.
- LOSS message can be deleted from the channel.
- JSON state persistence.

## Important
Your previously shared Telegram bot token should be considered compromised. Revoke/regenerate it in BotFather and put the NEW token only in `config.js`. Never commit `config.js` to GitHub.

## Hold logic
Default:
- Threshold: 3 consecutive losses
- Hold: 2 upcoming periods
- While holding, the bot continues reading the API so it can detect new periods, but does NOT publish predictions.
- After the hold count reaches zero, normal predictions resume.
- A WIN or JACKPOT resets the consecutive loss counter.

## Admin
Private chat with the admin:
- `/panel`
- `/sub USER_ID DAYS`
- `/unsub USER_ID`
- `/premium`
- `/sessions`
- `/health`

The inline panel is admin-only.

## Deployment
Use Node.js 18+.
1. `npm install`
2. Put your new token in `config.js`
3. `npm start`

For GitHub/Render, keep `config.js` private or use environment variables/secrets. A free web service may sleep, so it is not a guaranteed 24/7 host.


## v4.2 Premium Command Deck visual analytics
- 📈 CHART sends a real SVG visual result chart to Telegram.
- 🌡 HEATMAP sends a real 24-hour Dhaka-time loss heatmap to Telegram.
- No extra image-rendering package is required.


## Premium Command Deck
This version intentionally stays inside Telegram: no Web App is required. The admin panel uses a polished inline-keyboard command deck with live metrics, visual chart/heatmap documents, premium user controls, hold history, sessions, engine and message studio.
